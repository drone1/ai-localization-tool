import { program } from 'commander'
import { pathToFileURL, fileURLToPath } from 'url'
import { Buffer } from 'buffer'
import axios from 'axios'
import os from 'os'
import stripJsonComments from 'strip-json-comments'
import figlet from 'figlet'
import chalk from 'chalk'
import terminalSize from 'term-size'
import * as fs from 'fs/promises'
import * as crypto from 'crypto'
import * as path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LOCALIZATION_FILENAME = '.localization.json'

const CWD = process.cwd()
const appState = {}

// Helper function to parse comma-separated list
function commaSeparatedList(value) {
  return value.split(',').map(item => item.trim())
}

// Calculate hash of a string
function calculateHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

async function readFileAsText(filePath) {
  try {
    console.debug(`Reading file "${filePath}"...`)
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function isValidJson(s) {
  try {
    JSON.parse(s)
    return true
  } catch(e) {
    return false
  }
}

// Read and parse JSONC file
async function readJsonFile(filePath, isJSONComments = false) {
  const content = await readFileAsText(filePath)
  return isJSONComments 
    ? JSON.parse(stripJsonComments.stripJsonComments(content))
    : JSON.parse(content)
}

// Dynamically imports the javascript file at filePath, which can be relative or absolute
async function importJsFile(filePath) {
  console.log('importJsFile', filePath)
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
  const normalizedData = {}
  for (const [key, value] of Object.entries(data)) {
    // Force UTF-8 encoding for the key
    const utf8Key = Buffer.from(key, 'utf8').toString('utf8')
    
    // Force UTF-8 encoding for string values
    const utf8Value = typeof value === 'string' 
      ? Buffer.from(value, 'utf8').toString('utf8') 
      : value

    console.log(`Normalized key ${utf8Key}...`)
    
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

function d(...args) { console.log(...args)}

async function printLogo({tagline}) {
    const { columns } = terminalSize()

    const fontPath = path.resolve(__dirname, './figlet-fonts/isometric1.flf')
    const fontData = await fs.readFile(fontPath, 'utf8')
    
    // Register the font with Figlet
    figlet.parseFont('isometric1', fontData)

    // Generate ASCII art title
    const asciiTitle = figlet.textSync('ALT', {
      font: 'isometric1',
      horizontalLayout: 'full',
      verticalLayout: 'default'
    })

    // Center each line of the ASCII art
    // Display the centered title
    console.log(`${chalk.cyan(asciiTitle)}\n`)
    
    // Center the tagline too
    console.log(chalk.yellow(tagline) + '\n')
}

// Main function
export async function run() {
  try {
    const p = await readJsonFile(path.resolve(__dirname, './package.json'))

    await printLogo({tagline: p.description})

    // Define CLI options
    program
      .version(p.version)
      .description(p.description)
      .requiredOption('-r, --reference <path>', 'Path to reference JSONC file (default language)')
      .requiredOption('-o, --output-dir <path>', 'Output directory for localized files')
      .option('-l, --languages <list>', 'Comma-separated list of language codes', commaSeparatedList)
      .option('-g, --referenceLanguage <language>', `The reference file's language`, 'en')
      .option('-v, --referenceVarName <var name>', `The exported variable in the reference file, e.g. export default = {...} you'd use 'default'`, 'default')
      .option('-f, --force', 'Force regeneration of all translations', false)
      .option('-p, --provider <name>', 'AI provider to use for translations (claude, openai)', 'claude')
      .option('-s, --stateFile <path>', 'Path to state file', null)
      .parse(process.argv)

    const options = program.opts()

    // Validate provider
    if (!VALID_TRANSLATION_PROVIDERS.includes(options.provider)) {
      console.error(`Error: Unknown provider "${options.provider}". Supported providers: ${VALID_TRANSLATION_PROVIDERS.join(', ')}`)
      process.exit(1)
    }

    const configFilePath = !options.stateFile
      ? path.resolve(options.outputDir, DEFAULT_LOCALIZATION_FILENAME)
      : options.stateFile

    console.log(configFilePath)

    const tmpDir = await mkTmpDir()
    appState.tmpDir = tmpDir

    // Load config file or create default
    console.log(`Attempting to load config file from "${configFilePath}"`)
    let config = await readJsonFile(configFilePath) || {
      referenceHash: '',
      languages: {},
      lastRun: null
    }

    // Read reference file
    // Copy to a temp location first so we can ensure it has an .mjs extension
    const tmpReferencePath = await copyFileToTempAndEnsureExtension({filePath: options.reference, tmpDir, ext: 'mjs'})
    const referenceContent = normalizeData(JSON.parse(JSON.stringify(await importJsFile(tmpReferencePath))))
    const referenceData = referenceContent[options.referenceVarName]
    const referenceHash = calculateHash(readFileAsText(options.reference).toString('utf8'))

//bufferToUtf8
    console.trace(referenceData)

    // Check if reference file has changed
    const referenceChanged = referenceHash !== config.referenceHash
    
    if (referenceChanged) {
      console.log('Reference file has changed since last run')
    }

    // Get languages from CLI or config
    const languages = options.languages || Object.keys(config.languages)
    
    if (!languages || languages.length === 0) {
      console.error('Error: No languages specified. Use --languages option or add languages to .localization.json')
      process.exit(1)
    }

    // Track changes for updating config
    const updatedConfig = {
      referenceHash,
      languages: {},
      lastRun: new Date().toISOString()
    }

    const { apiKey, api: translationProvider } = await loadTranslationProvider(options.provider)

    // Process each language
    for (const lang of languages) {
      console.log(`Processing language: ${lang}`)
      
      const outputFile = path.join(options.outputDir, `${lang.toLowerCase()}.json`)
      console.log('outputFile', outputFile)
      let outputData = normalizeData(await readJsonFile(outputFile))
      console.log(outputData)
      if (!isValidJson(outputData)) outputData = {}

      // TODO: NOT USED
      let needsUpdate = options.force || referenceChanged
      
      // Initialize language in config if it doesn't exist
      if (!config.languages[lang]) {
        config.languages[lang] = { keyHashes: {} }
        needsUpdate = true
      }
      
      updatedConfig.languages[lang] = { keyHashes: {} }
      
      // Check if output file exists and has correct structure
      if (!outputData) {
        console.log(`Creating new file for language: ${lang}`)
        outputData = {}
        needsUpdate = true
      }

      Object.keys(outputData).forEach(key => {
        console.log(`Output key: "${key}", Bytes:`, Buffer.from(key).toString('hex'))
      })

      // Process each key in reference file
      for (const key of Object.keys(referenceData)) {
        d('key', key)
        d(outputData[key])
        const refValue = referenceData[key]

      // When reading keys from files
       console.log(`Reference key: "${key}", Bytes:`, Buffer.from(key).toString('hex'))

        // Skip non-string values (objects, arrays, etc.)
        if (typeof refValue !== 'string') {
          outputData[key] = refValue
          console.warn(`Value for reference key "${key}" was not a string! Skipping...`)
          continue
        }
        
        const currentValueHash = outputData[key] ? calculateHash(outputData[key]) : null
        const storedHash = config.languages[lang]?.keyHashes?.[key]

        console.log('currentValueHash', currentValueHash)
        console.log('storedHash', storedHash)
        
        // Check if translation needs update
        if (
          options.force || 
          !outputData[key] || 
          !storedHash || 
          currentValueHash !== storedHash
        ) {
          console.log(`Translating key "${key}" for language "${lang}"`)
          
          try {
            // Call translation provider
            const translated = await translationProvider.translate({
              text: refValue,
              targetLang: lang,
              sourceLang: options.referenceLanguage,
              apiKey,
              deps: { axios }
            })

            console.log(translated)
            outputData[key] = translated
            
            // Update hash in config
            const hashForTranslated = calculateHash(outputData[key])
            console.log(hashForTranslated)
            updatedConfig.languages[lang].keyHashes[key] = hashForTranslated
          } catch (error) {
            console.error(`Error translating key "${key}" for language "${lang}":`, error.message)
            // Keep existing translation if available
            if (outputData[key]) {
              updatedConfig.languages[lang].keyHashes[key] = currentValueHash
            }
          }
        } else {
          // Keep existing translation and hash
          console.log(`Keeping existing translation and hash for ${lang}/${key}...`)
          updatedConfig.languages[lang].keyHashes[key] = storedHash
        }
      }
      
      // Write updated translations
      await writeJsonFile(outputFile, outputData)
      console.log(`Updated ${outputFile}`)
    
      // Update state file every time, in case the user kills the process
      await writeJsonFile(configFilePath, updatedConfig)
      console.log(`Updated ${configFilePath}`)
    }

    await shutdown(appState)

    console.log('Localization completed successfully')
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
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

async function shutdown(appState) {
  if (appState?.tmpDir) {
    console.log(`Cleaning up...`)
    rmDir(appState.tmpDir)
  }
}

process.on('SIGINT', async () => await shutdown(appState))
process.on('SIGTERM', async () => await shutdown(appState))
