/**
 * Translate text using Claude API
 * 
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code
 * @param {string} sourceLang - Source language code
 * @param {string} apiKey - Claude API key
 * @returns {Promise<string>} - Translated text
 */
export async function translate({text, targetLang, sourceLang, apiKey, deps: { axios }}) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: "claude-3-sonnet-20240229",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `Translate the following text from ${sourceLang} to ${targetLang}. Only return the translated text, no explanations or additional comments:

${text}`
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }
    )

    // Extract just the text content from the response
    return response.data.content[0].text.trim()
  } catch (error) {
    console.error('Claude API error:', error.response?.data || error.message)
    throw new Error(`Claude translation failed: ${error.message}`)
  }
}
