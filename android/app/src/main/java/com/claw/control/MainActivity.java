package com.claw.control;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    /** Target view we listen on (the WebView's parent container). */
    private View insetTargetView;

    /** Most recent inset values, in CSS px, cached so we can re-inject on page load. */
    private int lastTopCss = 0;
    private int lastBottomCss = 0;
    private int lastLeftCss = 0;
    private int lastRightCss = 0;
    private boolean haveInsets = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ConnectionServicePlugin.class);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
        setupInsetsHandling();
    }

    /**
     * Handles safe area insets and keyboard resizing from the native side.
     *
     * On Android with edge-to-edge (enforced on API 35+), the WebView draws
     * behind the system bars but CSS env(safe-area-inset-*) returns 0, so the
     * web layer relies on the --safe-area-inset-* custom properties we inject
     * here (see src/styles/index.css).
     *
     * The catch: window insets are first dispatched during the initial layout
     * pass, which happens BEFORE the WebView has finished loading the SPA. An
     * injection at that point lands on about:blank and is lost, and (absent a
     * rotation or keyboard event) the listener never fires again — leaving the
     * loaded document with no inset values and the top bar drawn behind the
     * status bar (issue #27).
     *
     * The fix has two parts:
     * 1. The inset listener caches the latest values and injects them.
     * 2. A WebViewListener re-injects the cached values (and forces a fresh
     *    inset dispatch) every time a page finishes loading, so the live SPA
     *    document always receives the correct insets. This is condition-based
     *    (page-loaded) rather than a fragile fixed delay.
     */
    private void setupInsetsHandling() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        insetTargetView = (View) getBridge().getWebView().getParent();

        ViewCompat.setOnApplyWindowInsetsListener(insetTargetView, (view, windowInsets) -> {
            // The per-view insets dispatched to the WebView's container can be
            // inflated under edge-to-edge (observed: the status bar reported as
            // ~2x its real height on Android 16), which would over-pad the top.
            // The root window insets are authoritative, so use them for the
            // safe-area values and fall back to the per-view insets only if the
            // root insets aren't available yet.
            WindowInsetsCompat rootInsets =
                ViewCompat.getRootWindowInsets(getWindow().getDecorView());
            WindowInsetsCompat source = rootInsets != null ? rootInsets : windowInsets;

            // systemBars covers status + navigation bars; displayCutout covers
            // notches / punch-holes (relevant in landscape).
            Insets bars = source.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            // The keyboard (ime) inset must come from the per-view insets, which
            // carry the live keyboard state for this dispatch.
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            boolean imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());

            // CSS px in a WebView correspond to device-independent pixels (the
            // WebView already accounts for density), so divide native px by density.
            float density = getResources().getDisplayMetrics().density;
            lastTopCss = Math.round(bars.top / density);
            lastLeftCss = Math.round(bars.left / density);
            lastRightCss = Math.round(bars.right / density);
            // When the keyboard is visible it covers the nav bar, so the bottom
            // inset is 0 (the WebView is also resized below).
            lastBottomCss = imeVisible ? 0 : Math.round(bars.bottom / density);
            haveInsets = true;

            injectInsets();

            // Resize the WebView container when the keyboard is showing.
            // Setting bottom margin shrinks the container, which makes 100dvh
            // automatically adapt — no JS-side keyboard handling needed.
            ViewGroup.MarginLayoutParams params =
                (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            params.bottomMargin = imeVisible ? ime.bottom : 0;
            view.setLayoutParams(params);

            // Consume insets so the WebView doesn't also try to handle them
            return WindowInsetsCompat.CONSUMED;
        });

        // Re-inject insets after each page load. The initial inset dispatch
        // typically happens before the SPA finishes loading, so without this the
        // loaded document would never receive the values.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                runOnUiThread(() -> {
                    if (haveInsets) injectInsets();
                    // Force a fresh inset dispatch in case insets weren't
                    // available yet when the page finished loading.
                    if (insetTargetView != null) {
                        ViewCompat.requestApplyInsets(insetTargetView);
                    }
                });
            }
        });
    }

    /** Pushes the cached inset values into the WebView as CSS custom properties. */
    private void injectInsets() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        String js = String.format(
            Locale.US,
            "document.documentElement.style.setProperty('--safe-area-inset-top','%dpx');" +
            "document.documentElement.style.setProperty('--safe-area-inset-right','%dpx');" +
            "document.documentElement.style.setProperty('--safe-area-inset-bottom','%dpx');" +
            "document.documentElement.style.setProperty('--safe-area-inset-left','%dpx');",
            lastTopCss, lastRightCss, lastBottomCss, lastLeftCss
        );
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
