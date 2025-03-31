import { program } from 'commander'
import { Buffer } from 'buffer'
import { pathToFileURL, fileURLToPath } from 'url'
import { Listr } from 'listr2'
import axios from 'axios'
import os from 'os'
import stripJsonComments from 'strip-json-comments'
import figlet from 'figlet'
import gradient from 'gradient-string'
import * as locale from 'locale-codes'
import * as fs from 'fs/promises'
import * as crypto from 'crypto'
import * as path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CACHE_FILENAME = '.localization.cache.json'
const DEFAULT_CONFIG_FILENAME = 'config.json'

const CWD = process.cwd()
const appState = {}

// Helper function to parse comma-separated list
function languageList(value) {
  const languages = value.split(',').map(item => item.trim())
  const invalid = languages.filter(lang => !locale.getByTag(lang))
  if (invalid.length) {
    console.error(`Found invalid language(s): ${invalid.join(', ')}`)
    process.exit(1)
  }
  return languages
}

// Calculate hash of a string
function calculateHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function readFileAsText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function parseJson(s) {
  try {
    return JSON.parse(s)
  } catch(e) {
    return null
  }
}

// Read and parse JSONC file
async function readJsonFile(filePath, isJSONComments = false) {
  let content = await readFileAsText(filePath)
  if (isJSONComments) content = stripJsonComments.stripJsonComments(content)
  return parseJson(content)
}

// Dynamically imports the javascript file at filePath, which can be relative or absolute
async function importJsFile(filePath) {
  if (!path.isAbsolute(filePath)) {
    filePath = path.resolve(CWD, filePath)
  }
  // Convert the file path to a proper URL
  const fileUrl = pathToFileURL(filePath)
  return await import(fileUrl)
}

function normalizeKey(key) {
  return key.normalize('NFC') // Normalized Form C is generally recommended
}

function normalizeData(data) {
  if (!data) return null
  const normalizedData = {}
  for (const [key, value] of Object.entries(data)) {
    // Force UTF-8 encoding for the key
    const utf8Key = Buffer.from(key, 'utf8').toString('utf8')
    
    // Force UTF-8 encoding for string values
    const utf8Value = typeof value === 'string' 
      ? Buffer.from(value, 'utf8').toString('utf8') 
      : value

    normalizedData[normalizeKey(utf8Key)] = utf8Value
  }
  return normalizedData
}

function bufferToUtf8(buffer) {
  // If it's already a string, return it
  if (typeof buffer === 'string') return buffer
  
  // If it's a Buffer, convert to UTF-8 string
  if (Buffer.isBuffer(buffer)) {
    return buffer.toString('utf8')
  }
  
  // If it's an ArrayBuffer or TypedArray, convert to Buffer first
  if (buffer instanceof ArrayBuffer || 
      (typeof buffer === 'object' && buffer.buffer instanceof ArrayBuffer)) {
    return Buffer.from(buffer).toString('utf8')
  }
  
  // Fallback - try to convert whatever it is to a string
  return String(buffer)
}

// Write JSON file
async function writeJsonFile(filePath, data) {
  // Create normalized version of data with consistent key encoding
  const normalizedData = {}
  for (const [key, value] of Object.entries(data)) {
    normalizedData[normalizeKey(key)] = value
  }
  
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(normalizedData, null, 2), 'utf8')
}

async function loadTranslationProvider(providerName) {
  const apiKeyName = `${providerName.toUpperCase()}_API_KEY`
  const apiKey = process.env[apiKeyName]
  if (!apiKey?.length) throw new Error('${apiKeyName} environment variable is not set')
  return {
    apiKey,
    api: await importJsFile(path.resolve(__dirname, `providers/${providerName}.mjs`))
  }
}

const VALID_TRANSLATION_PROVIDERS = ['claude', 'openai']

async function printLogo({ tagline }) {
  const fontName = 'THIS.flf'
  const fontPath = path.resolve(__dirname, `./figlet-fonts/${fontName}`)
  const fontData = await fs.readFile(fontPath, 'utf8')
  figlet.parseFont(fontName, fontData)
  const asciiTitle = figlet.textSync('ALT', {
    font: fontName,
    horizontalLayout: 'full',
    verticalLayout: 'default'
  })

  console.log(`\n${gradient(['#000FFF', '#ed00b1'])(asciiTitle)}\n`)
}

// Main function
export async function run() {
  try {
    const p = await readJsonFile(path.resolve(__dirname, './package.json'))
    if (!p) throw new Error(`Couldn't read 'package.json'`)

    // Define CLI options
    program
      .version(p.version)
      .description(p.description)
      .requiredOption('-r, --reference <path>', 'Path to reference JSONC file (default language)')
      .requiredOption('-o, --output-dir <path>', 'Output directory for localized files')
      .option('-l, --languages <list>', 'Comma-separated list of language codes', languageList)
      .option('-g, --referenceLanguage <language>', `The reference file's language`, 'en')
      .option('-j, --referenceVarName <var name>', `The exported variable in the reference file, e.g. export default = {...} you'd use 'default'`, 'default')
      .option('-f, --force', 'Force regeneration of all translations', false)
      .option('-p, --provider <name>', 'AI provider to use for translations (claude, openai)', 'claude')
      .option('-s, --simpleRenderer', 'Use simple renderer; useful for CI', false)
      .option('-c, --config <path>', 'Path to config file', null)
      .option('-t, --maxRetries <integer>', 'Maximum retries on failure', 3)
      .option('-c, --concurrent', `Maximum # of concurrent tasks`, 4)
      .option('-v, --verbose', `Enables verbose spew`, false)
      .option('-d, --debug', `Enables debug spew`, false)
      .parse(process.argv)

    await printLogo({tagline: p.description})
    const options = program.opts()

    const log = {
      e: function(...args) { console.error(...args)},
      w: function(...args) { console.warn(...args)},
      d: options.debug ? function(...args) { console.debug(...args)} : () => {},
      v: (options.debug || options.verbose) ? function(...args) { console.log(...args)} : () => {},
      i: function(...args) { console.log(...args)}
    }

    appState.log = log

    // Validate provider
    if (!VALID_TRANSLATION_PROVIDERS.includes(options.provider)) {
      console.error(`Error: Unknown provider "${options.provider}". Supported providers: ${VALID_TRANSLATION_PROVIDERS.join(', ')}`)
      process.exit(1)
    }

    // Create a tmp dir for storing the .mjs referen ce file; we can't dynamically import .js files directly, so we make a copy...
    const tmpDir = await mkTmpDir()
    appState.tmpDir = tmpDir
    //
    // Load config file or create default
    const configFilePath = !options.config
      ? path.resolve(options.outputDir, DEFAULT_CONFIG_FILENAME)
      : options.config
    log.v(`Attempting to load config file from "${configFilePath}"`)
    let config = await readJsonFile(configFilePath) || {
      languages: [],
      referenceLanguage: 'en',
    }

    const cacheFilePath = path.resolve(options.outputDir, DEFAULT_CACHE_FILENAME)
    log.v(`Attempting to load cache file from "${cacheFilePath}"`)
    const cache = await readJsonFile(cacheFilePath) || {
      referenceHash: '',
      state: {},
      lastRun: null
    }
    // Copy to a temp location first so we can ensure it has an .mjs extension
    const tmpReferencePath = await copyFileToTempAndEnsureExtension({filePath: options.reference, tmpDir, ext: 'mjs'})
    const referenceContent = normalizeData(JSON.parse(JSON.stringify(await importJsFile(tmpReferencePath))), log)  // TODO: Don't do this
    const referenceData = referenceContent[options.referenceVarName]
    if (!referenceData) {
      log.e(`No reference data found in variable "${options.referenceVarName}" in ${options.reference}`)
      process.exit(1)
    }

    const referenceHash = calculateHash(readFileAsText(options.reference).toString('utf8'))

    const referenceChanged = referenceHash !== cache.referenceHash
    if (referenceChanged) {
      log.v('Reference file has changed since last run')
    }

    // Get languages from CLI or config
    const languages = options.languages || config.languages
    if (!languages || languages.length === 0) {
      console.error('Error: No languages specified. Use --languages option or add languages to your config file')
      process.exit(1)
    }

    cache.referenceHash = referenceHash
    cache.lastRun = new Date().toISOString()

    const { apiKey, api: translationProvider } = await loadTranslationProvider(options.provider)

    const tasks = new Listr([], {
      concurrent: false, // Process languages one by one
      ...(options.simpleRenderer ? { renderer: 'simple' } : {}),
      rendererOptions: { collapse: false, clearOutput: false },
      clearOutput: false,
    })

    // Process each language
    for (const lang of languages) {
      let stringsTranslatedForLanguage = 0

      let needsUpdate = options.force || referenceChanged
      
      //const rootSpinner = ora(`[${lang}] Processing all keys for language...`).start()
      
      const outputFilePath = path.join(options.outputDir, `${lang.toLowerCase()}.json`)
      let outputData = normalizeData(await readJsonFile(outputFilePath)) || {}
      log.d('outputData', outputData)
      log.d(Object.keys(outputData))

      // Initialize language in cache if it doesn't exist
      if (!cache.state[lang]) {
        log.v(`lang ${lang} not in cache; update needed...`)
        cache.state[lang] = { keyHashes: {} }
        needsUpdate = true
      }
      
      // Check if output file exists and has correct structure
      if (!outputData) {
        //rootSpinner.info(`File for language "${lang}" did not exist; update needed...`)
        outputData = {}
        needsUpdate = true
      }

      log.d(outputData)

      Object.keys(outputData).forEach(key => {
        log.d(`Output key: "${key}", Bytes:`, Buffer.from(key).toString('hex'))
      })

      tasks.add([{
          title: `Localize "${lang}"`,
          task: async (ctx, task) => {
            ctx.nextTaskDelayMs = 0
            const subtasks = Object.keys(referenceData).map(key => ({
                title: `Processing "${key}"`,
                task: async (ctx, subtask) => {
                  const { success, translated, newValue, error } = await translateKeyForLanguage({
                    task: subtask,
                    ctx,
                    translationProvider,
                    apiKey,
                    cache,
                    lang,
                    key, 
                    refValue: referenceData[key],
                    curValue: (key in outputData) ? outputData[key] : null,
                    options,
                    log
                  })

                  if (success) {
                    ++stringsTranslatedForLanguage 

                    // Write updated translations
                    outputData[key] = newValue
                    await writeJsonFile(outputFilePath, outputData)
                    log.v(`Wrote ${outputFilePath}`)

                    // Update state file every time, in case the user kills the process
                    await writeJsonFile(cacheFilePath, cache)
                    log.v(`Wrote ${cacheFilePath}`)

                    subtask.title = translated ? `Translated ${key}: "${newValue}"` : `No update needed for ${key}`
                  } else if (error) {
                    throw new Error(error)
                  }
                }
              }))

            return task.newListr(
              subtasks, {
                concurrent: parseInt(options.concurrent),
                rendererOptions: { collapse: true, persistentOutput: true },
              }
            )
        }
      }])

      //rootSpinner.succeed(`[${lang}] Processed with ${stringsTranslatedForLanguage === 0 ? 'no' : stringsTranslatedForLanguage} updates`)
    }

    tasks.add({
      'title': 'Cleanup',
      task: () => shutdown(appState, false)
    })

    await tasks.run()
  } catch (error) {
    console.error('Error:', error)  // NB: 'log' doesn't exist here
    process.exit(1)
  }
}

async function translateKeyForLanguage({task, ctx, translationProvider, apiKey, cache, lang, key, refValue, curValue, options: { force, referenceLanguage, maxRetries }, log}) {
  const result = { success: true, translated: false, newValue: null, error: null }

  // When reading keys from files
  log.d(`Reference key: "${key}", Bytes:`, Buffer.from(key).toString('hex'))

  // Skip non-string values (objects, arrays, etc.)
  if (typeof refValue !== 'string') {
    result.error = `Value for reference key "${key}" was not a string! Skipping...`
    result.success = false
    return result
  }
  
  const currentValueHash = curValue?.length ? calculateHash(curValue) : null
  const storedHash = cache.state[lang]?.keyHashes?.[key]

  log.d('currentValueHash', currentValueHash)
  log.d('storedHash', storedHash)
  
  // Check if translation needs update
  const missingOutputKey = curValue === null
  const hashesDiffer = currentValueHash !== storedHash

  //const languageSpinner = ora({ prefixText: ' ', text: `Processing key "${key}"...` }).start()

  if (
    force || 
    missingOutputKey || 
    !storedHash || 
    hashesDiffer
  ) {
    if (force) log.d(`Forcing update...`)
    if (missingOutputKey) log.d(`No "${key}" in output data...`)
    if (!storedHash) log.d(`Hash was not found in storage...`)
    if (hashesDiffer) log.d(`Hashes differ (${currentValueHash} / ${storedHash})...`)

    try {
      // Call translation provider
      //languageSpinner.info(`[${lang}] Translating "${key}"...`)
      log.d(`[${lang}] Translating "${key}"...`)
      task.title = `Translating "${key}"...`

      const providerName = translationProvider.name()
      task.title = `Translating with ${providerName}`
      let translated = null
      let newValue

      for (let attempt = 0; !newValue && attempt <= maxRetries; ++attempt) {
        log.d(`[translate] attempt=${attempt}`)

        if (ctx.nextTaskDelayMs > 0) {
          task.title = `Rate limited; sleeping for ${Math.floor(ctx.nextTaskDelayMs/1000)}s...`
          await sleep(ctx.nextTaskDelayMs)
        }

        const translateResult = await translate({
          task,
          provider: translationProvider,
          text: refValue,
          sourceLang: referenceLanguage,
          targetLang: lang,
          apiKey,
          maxRetries: maxRetries,
          log,
        })

        if (translateResult.rateLimited) {
          task.title = 'Rate limited'
          const sleepInterval = translateResult.response?.headers ? translationProvider.getSleepInterval(translateResult.response.headers) : 0
          console.log(sleepInterval)
          ctx.nextTaskDelayMs = Math.max(ctx.nextTaskDelayMs, sleepInterval)
        } else {
          newValue = translateResult.translated
        }
      }
    
      if (!newValue?.length) throw new Error(`Translation was empty`)

      log.d('translated text', newValue)
      result.translated = true
      result.newValue = newValue
   
      const hashForTranslated = calculateHash(newValue)
      log.d(`Updating hash for translated ${lang}.${key}: ${hashForTranslated}`)
      cache.state[lang].keyHashes[key] = hashForTranslated
    } catch (error) {
      throw error
      //languageSpinner.warn(`Failed to translate key "${key}" for language "${lang}": ${error.message}`)
      // Keep existing translation if available
      //if (curValue) {
        //cache.state[lang].keyHashes[key] = currentValueHash
        //languageSpinner.warn(`Error translating key "${key}" for language "${lang}": ${error.message}`)
      //}
    }
  } else {
    log.v(`Keeping existing translation and hash for ${lang}/${key}...`)
    cache.state[lang].keyHashes[key] = storedHash
  }

  return result
}

async function mkTmpDir() {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'alt-'))
}

function ensureExtension(filename, extension) {
  if (!extension.startsWith('.')) extension = '.' + extension
  return filename.endsWith(extension) ? filename : filename + extension
}

// This is basically so that we can dynamicaly import .js files by copying them to temp .mjs files, to avoid errors from node
async function copyFileToTempAndEnsureExtension({filePath, tmpDir, ext}) {
  try {
    const fileName = ensureExtension(path.basename(filePath), ext)
    const destPath = path.join(tmpDir, fileName)
    await fs.copyFile(filePath, destPath)
    return destPath
  } catch (error) {
    console.error(`Error copying file to temp directory: ${error.message}`)
    throw error
  }
}

async function rmDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    console.error(`Error cleaning up temp directory "${dir}": ${error.message}`)
    throw error
  }
}

async function shutdown(appState, exit) {
  if (appState?.tmpDir) {
    rmDir(appState.tmpDir)
    if (exit) process.exit(1)
  }
}

export function sleep(ms, log) {
	if (ms === 0) return
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function translate({task, provider, text, sourceLang, targetLang, apiKey, log }) {
  const result = { translated: null, rateLimited: false, response: null }

  try {
    const providerName = provider.name()
    task.title = `Preparing endpoint configuration...`
    const { url, params, config } = provider.getTranslationRequestDetails({ text, sourceLang, targetLang, apiKey, log })
    task.title = `Hitting ${providerName} endpoint...`
    const response = await axios.post(url, params, config)
    log.d('response headers', response.headers)
    const translated = provider.getResult(response, log)
    if (!translated?.length) throw new Error(`${providerName} translated text to empty string`)
    result.translated = translated
  } catch (error) {
    if (error.response && error.response.status === 429) {
      result.rateLimited = true
      result.response = error.response
    } else {
      log.w(`API failed with error`, error)
    }
  }

  return result
}

process.on('SIGINT', async () => await shutdown(appState, true))
process.on('SIGTERM', async () => await shutdown(appState, true))
