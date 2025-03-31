export function name() {
  return "OpenAI"
}

export function getTranslationRequestDetails({text, sourceLang, targetLang, apiKey, log }) {
  return {
      url: 'https://api.openai.com/v1/chat/completions',
      params: {
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
    config: {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
  }
}

export function getResult(response) {
  return response.data.choices[0].message.content.trim()
}
