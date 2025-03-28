/**
 * Translate text using OpenAI API
 * 
 * @param {string} text - Text to translate
 * @param {string} targetLang - Target language code
 * @param {string} sourceLang - Source language code
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<string>} - Translated text
 */
export async function translate({text, targetLang, sourceLang, apiKey, deps: { axios }}) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4-turbo",
        messages: [
          {
            role: "system",
            content: "You are a professional translator. Translate the text accurately without adding explanations or additional content."
          },
          {
            role: "user", 
            content: `Translate the following text from ${sourceLang} to ${targetLang}:\n\n${text}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1024
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
    )

    return response.data.choices[0].message.content.trim()
  } catch (error) {
    console.error('OpenAI API error:', error.response?.data || error.message)
    throw new Error(`OpenAI translation failed: ${error.message}`)
  }
}
