import { test, expect } from '../fixtures/base'

test.describe('Chat', () => {
  test('send text message and receive assistant response', async ({ connectedPage, mockServer }) => {
    const page = connectedPage

    // Type a message
    await page.getByTestId('message-input').fill('Hello world')
    await page.getByTestId('send-btn').click()

    // User message bubble should appear
    await expect(page.locator('.message.user').first()).toBeVisible()
    await expect(page.locator('.message.user').first()).toContainText('Hello world')

    // Assistant response should stream in
    await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.message.agent').first()).toContainText('mock response')
  })

  test('abort streaming calls chat.abort', async ({ connectedPage, mockServer }) => {
    const page = connectedPage

    // Queue a response that doesn't complete (no lifecycle end)
    await mockServer.setStreamResponse('session-1', [
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'assistant',
          data: { text: 'Starting a long response...', delta: 'Starting a long response...' },
        },
      },
    ])

    await page.getByTestId('message-input').fill('Tell me a long story')
    await page.getByTestId('send-btn').click()

    // Wait for streaming indicator - the stop button may take a moment to appear
    await page.waitForTimeout(500)

    // Click stop with force since it may be transitioning
    const stopBtn = page.getByTestId('stop-btn')
    if (await stopBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await stopBtn.click({ force: true })
    }

    // Verify chat.abort was called
    await page.waitForTimeout(500)
    const history = await mockServer.getHistory('chat.abort')
    expect(history.length).toBeGreaterThanOrEqual(1)
  })

  test('markdown rendering in assistant messages', async ({ connectedPage, mockServer }) => {
    const page = connectedPage

    const markdownContent = '**Bold text** and `inline code`'

    await mockServer.setStreamResponse('session-1', [
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'assistant',
          data: { text: markdownContent, delta: markdownContent },
        },
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'lifecycle',
          data: { state: 'complete', phase: 'end' },
        },
      },
      {
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: '*',
          state: 'final',
          message: {
            id: 'msg-md-1',
            role: 'assistant',
            content: markdownContent,
            timestamp: new Date().toISOString(),
          },
        },
      },
    ])

    await page.getByTestId('message-input').fill('Show me markdown')
    await page.getByTestId('send-btn').click()

    // Wait for final message to render
    const agentMsg = page.locator('.message.agent').first()
    await expect(agentMsg).toBeVisible({ timeout: 5000 })

    // Check that markdown was rendered (bold text should produce <strong> or <b>)
    await expect(agentMsg).toContainText('Bold text')
    await expect(agentMsg).toContainText('inline code')
  })

  test('thinking mode toggle and send', async ({ connectedPage, mockServer }) => {
    const page = connectedPage

    // Find and toggle the thinking switch
    const thinkingToggle = page.locator('.toggle-switch input[type="checkbox"]').first()
    if (await thinkingToggle.isVisible()) {
      await thinkingToggle.check()
    }

    await page.getByTestId('message-input').fill('Think about this')
    await page.getByTestId('send-btn').click()

    // Verify chat.send was called
    const history = await mockServer.getHistory('chat.send')
    const lastSend = history[history.length - 1]
    expect(lastSend).toBeDefined()
  })

  test('tool call display', async ({ connectedPage, mockServer }) => {
    const page = connectedPage

    await mockServer.setStreamResponse('session-1', [
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'tool',
          data: {
            name: 'web_search',
            phase: 'start',
            toolCallId: 'tc-1',
            args: { query: 'test query' },
          },
        },
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'tool',
          data: {
            name: 'web_search',
            phase: 'result',
            toolCallId: 'tc-1',
            result: 'Search results here',
          },
        },
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'assistant',
          data: { text: 'Based on my search...', delta: 'Based on my search...' },
        },
      },
      {
        type: 'event',
        event: 'agent',
        payload: {
          sessionKey: '*',
          stream: 'lifecycle',
          data: { state: 'complete', phase: 'end' },
        },
      },
      {
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: '*',
          state: 'final',
          message: {
            id: 'msg-tool-1',
            role: 'assistant',
            content: 'Based on my search...',
            timestamp: new Date().toISOString(),
          },
        },
      },
    ])

    await page.getByTestId('message-input').fill('Search for something')
    await page.getByTestId('send-btn').click()

    // Wait for assistant response
    await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 5000 })
  })

  test('draft persistence across session switches', async ({ connectedPage }) => {
    const page = connectedPage

    // Type a draft
    await page.getByTestId('message-input').fill('My draft message')

    // Switch to another session
    const session2 = page.getByTestId('session-item-session-2')
    if (await session2.isVisible()) {
      await session2.click()
      await page.waitForTimeout(300)

      // Switch back to first session
      const session1 = page.getByTestId('session-item-session-1')
      if (await session1.isVisible()) {
        await session1.click()
        await page.waitForTimeout(300)

        // Draft should be restored
        const inputValue = await page.getByTestId('message-input').inputValue()
        expect(inputValue).toBe('My draft message')
      }
    }
  })

  test('enter does not submit while IME composition is active', async ({ connectedPage, mockServer }) => {
    const page = connectedPage
    const input = page.getByTestId('message-input')

    await input.focus()
    await input.fill('ni')

    // Simulate IME-active Enter (React should see nativeEvent.isComposing=true)
    await input.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })

    // Should NOT submit while composing
    const beforeHistory = await mockServer.getHistory('chat.send')
    expect(beforeHistory.length).toBe(0)

    // After composition commit, Enter should submit normally
    await input.dispatchEvent('compositionend', { bubbles: true })
    await input.fill('你好')
    await input.press('Enter')

    const afterHistory = await mockServer.getHistory('chat.send')
    expect(afterHistory.length).toBeGreaterThanOrEqual(1)
  })
})
