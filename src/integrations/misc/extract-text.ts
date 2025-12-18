import ExcelJS from "exceljs"
import * as fsSync from "fs"
import fs from "fs/promises"
import * as iconv from "iconv-lite"
import { isBinaryFile } from "isbinaryfile"
import * as chardet from "jschardet"
import mammoth from "mammoth"
import * as path from "path"
// @ts-ignore-next-line
import pdf from "pdf-parse/lib/pdf-parse"

// ============================================================
// Encoding Debug Logger (Rolling Log)
// ============================================================
const ENCODING_LOG_DIR = "D:/cline_encoding_debug"
const ENCODING_LOG_PREFIX = "encoding"
const MAX_LOG_FILES = 5
const MAX_LOG_SIZE = 2 * 1024 * 1024 // 2MB

function ensureLogDir() {
	if (!fsSync.existsSync(ENCODING_LOG_DIR)) {
		fsSync.mkdirSync(ENCODING_LOG_DIR, { recursive: true })
	}
}

function getLogFiles(): string[] {
	ensureLogDir()
	return fsSync
		.readdirSync(ENCODING_LOG_DIR)
		.filter((f) => f.startsWith(ENCODING_LOG_PREFIX) && f.endsWith(".log"))
		.sort()
}

function getCurrentLogFile(): string {
	const files = getLogFiles()
	if (files.length === 0) {
		return path.join(ENCODING_LOG_DIR, `${ENCODING_LOG_PREFIX}_001.log`)
	}

	const latestFile = path.join(ENCODING_LOG_DIR, files[files.length - 1])
	try {
		const stats = fsSync.statSync(latestFile)
		if (stats.size >= MAX_LOG_SIZE) {
			// Need to create new file
			const nextNum = files.length + 1
			if (nextNum > MAX_LOG_FILES) {
				// Delete oldest file
				fsSync.unlinkSync(path.join(ENCODING_LOG_DIR, files[0]))
			}
			const newNum = Math.min(nextNum, MAX_LOG_FILES)
			return path.join(ENCODING_LOG_DIR, `${ENCODING_LOG_PREFIX}_${String(newNum).padStart(3, "0")}.log`)
		}
	} catch (e) {
		// File doesn't exist, will create new
	}
	return latestFile
}

function rotateIfNeeded() {
	const files = getLogFiles()
	if (files.length > MAX_LOG_FILES) {
		// Delete old files
		const toDelete = files.slice(0, files.length - MAX_LOG_FILES)
		toDelete.forEach((f) => {
			try {
				fsSync.unlinkSync(path.join(ENCODING_LOG_DIR, f))
			} catch (e) {}
		})
	}
}

// Suspicious encodings that may indicate misdetection
const SUSPICIOUS_ENCODINGS = ["GB2312", "GB18030", "Big5", "GBK", "EUC-KR", "EUC-JP", "ISO-2022-JP", "ISO-2022-KR", "HZ-GB-2312"]
const SAFE_ENCODINGS = ["utf-8", "UTF-8", "ascii", "ASCII", "utf8", "UTF8"]

function shouldLogEncoding(detected: any, finalEncoding: string): boolean {
	const confidence = detected?.confidence ?? 1
	// Log if: suspicious encoding, low confidence, or non-UTF8/ASCII
	return (
		SUSPICIOUS_ENCODINGS.some((e) => finalEncoding.toUpperCase().includes(e.toUpperCase())) ||
		confidence < 0.9 ||
		!SAFE_ENCODINGS.some((e) => finalEncoding.toUpperCase() === e.toUpperCase())
	)
}

function logEncoding(
	filePath: string,
	detected: any,
	finalEncoding: string,
	bufferSize: number,
	firstBytes: string,
	decodedPreview?: string,
) {
	try {
		ensureLogDir()
		rotateIfNeeded()

		const logFile = getCurrentLogFile()
		const timestamp = new Date().toISOString()
		const logEntry = {
			timestamp,
			filePath,
			detected,
			finalEncoding,
			bufferSize,
			firstBytes,
			decodedPreview,
		}
		fsSync.appendFileSync(logFile, JSON.stringify(logEntry) + "\n")
	} catch (e) {
		// Ignore logging failures
	}
}
// ============================================================

export async function detectEncoding(fileBuffer: Buffer, fileExtension?: string, filePath?: string): Promise<string> {
	const detected = chardet.detect(fileBuffer)
	const firstBytes = fileBuffer.slice(0, 100).toString("hex")

	let finalEncoding: string

	if (typeof detected === "string") {
		finalEncoding = detected
	} else if (detected && (detected as any).encoding) {
		finalEncoding = (detected as any).encoding
	} else {
		if (fileExtension) {
			const isBinary = await isBinaryFile(fileBuffer).catch(() => false)
			if (isBinary) {
				throw new Error(`Cannot read text for file type: ${fileExtension}`)
			}
		}
		finalEncoding = "utf8"
	}

	// Only log suspicious cases (non-UTF8, low confidence, or Chinese/Korean encodings)
	if (shouldLogEncoding(detected, finalEncoding)) {
		// Include decoded preview for suspicious cases
		let decodedPreview: string | undefined
		try {
			decodedPreview = iconv.decode(fileBuffer.slice(0, 500), finalEncoding).substring(0, 200)
		} catch (e) {
			decodedPreview = "(decode failed)"
		}
		logEncoding(
			filePath || fileExtension || "unknown",
			detected,
			finalEncoding,
			fileBuffer.length,
			firstBytes,
			decodedPreview,
		)
	}

	return finalEncoding
}

export async function extractTextFromFile(filePath: string): Promise<string> {
	try {
		await fs.access(filePath)
	} catch (_error) {
		throw new Error(`File not found: ${filePath}`)
	}

	return callTextExtractionFunctions(filePath)
}

/**
 * Expects the fs.access call to have already been performed prior to calling
 */
export async function callTextExtractionFunctions(filePath: string): Promise<string> {
	const fileExtension = path.extname(filePath).toLowerCase()

	switch (fileExtension) {
		case ".pdf":
			return extractTextFromPDF(filePath)
		case ".docx":
			return extractTextFromDOCX(filePath)
		case ".ipynb":
			return extractTextFromIPYNB(filePath)
		case ".xlsx":
			return extractTextFromExcel(filePath)
		default:
			const fileBuffer = await fs.readFile(filePath)
			if (fileBuffer.byteLength > 20 * 1000 * 1024) {
				// 20MB limit (20 * 1000 * 1024 bytes, decimal MB)
				throw new Error(`File is too large to read into context.`)
			}
			const encoding = await detectEncoding(fileBuffer, fileExtension)
			return iconv.decode(fileBuffer, encoding)
	}
}

async function extractTextFromPDF(filePath: string): Promise<string> {
	const dataBuffer = await fs.readFile(filePath)
	const data = await pdf(dataBuffer)
	return data.text
}

async function extractTextFromDOCX(filePath: string): Promise<string> {
	const result = await mammoth.extractRawText({ path: filePath })
	return result.value
}

async function extractTextFromIPYNB(filePath: string): Promise<string> {
	const fileBuffer = await fs.readFile(filePath)
	const encoding = await detectEncoding(fileBuffer)
	const data = iconv.decode(fileBuffer, encoding)
	const notebook = JSON.parse(data)
	let extractedText = ""

	for (const cell of notebook.cells) {
		if ((cell.cell_type === "markdown" || cell.cell_type === "code") && cell.source) {
			extractedText += cell.source.join("\n") + "\n"
		}
	}

	return extractedText
}

/**
 * Format the data inside Excel cells
 */
function formatCellValue(cell: ExcelJS.Cell): string {
	const value = cell.value
	if (value === null || value === undefined) {
		return ""
	}

	// Handle error values (#DIV/0!, #N/A, etc.)
	if (typeof value === "object" && "error" in value) {
		return `[Error: ${value.error}]`
	}

	// Handle dates - ExcelJS can parse them as Date objects
	if (value instanceof Date) {
		return value.toISOString().split("T")[0] // Just the date part
	}

	// Handle rich text
	if (typeof value === "object" && "richText" in value) {
		return value.richText.map((rt) => rt.text).join("")
	}

	// Handle hyperlinks
	if (typeof value === "object" && "text" in value && "hyperlink" in value) {
		return `${value.text} (${value.hyperlink})`
	}

	// Handle formulas - get the calculated result
	if (typeof value === "object" && "formula" in value) {
		if ("result" in value && value.result !== undefined && value.result !== null) {
			return value.result.toString()
		} else {
			return `[Formula: ${value.formula}]`
		}
	}

	return value.toString()
}

/**
 * Extract and format text from xlsx files
 */
async function extractTextFromExcel(filePath: string): Promise<string> {
	const workbook = new ExcelJS.Workbook()
	let excelText = ""

	try {
		await workbook.xlsx.readFile(filePath)

		workbook.eachSheet((worksheet, _sheetId) => {
			// Skip hidden sheets
			if (worksheet.state === "hidden" || worksheet.state === "veryHidden") {
				return
			}

			excelText += `--- Sheet: ${worksheet.name} ---\n`

			worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
				// Optional: limit processing for very large sheets
				if (rowNumber > 50000) {
					excelText += `[... truncated at row ${rowNumber} ...]\n`
					return false
				}

				const rowTexts: string[] = []
				let hasContent = false

				row.eachCell({ includeEmpty: true }, (cell, _colNumber) => {
					const cellText = formatCellValue(cell)
					if (cellText.trim()) {
						hasContent = true
					}
					rowTexts.push(cellText)
				})

				// Only add rows with actual content
				if (hasContent) {
					excelText += rowTexts.join("\t") + "\n"
				}

				return true
			})

			excelText += "\n" // Blank line between sheets
		})

		return excelText.trim()
	} catch (error: any) {
		console.error(`Error extracting text from Excel ${filePath}:`, error)
		throw new Error(`Failed to extract text from Excel: ${error.message}`)
	}
}

/**
 * Helper function used to load file(s) and format them into a string
 */
export async function processFilesIntoText(files: string[]): Promise<string> {
	const fileContentsPromises = files.map(async (filePath) => {
		try {
			// Check if file exists and is binary
			//const isBinary = await isBinaryFile(filePath).catch(() => false)
			//if (isBinary) {
			//	return `<file_content path="${filePath.toPosix()}">\n(Binary file, unable to display content)\n</file_content>`
			//}
			const content = await extractTextFromFile(filePath)
			return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
		} catch (error) {
			console.error(`Error processing file ${filePath}:`, error)
			return `<file_content path="${filePath.toPosix()}">\nError fetching content: ${error.message}\n</file_content>`
		}
	})

	const fileContents = await Promise.all(fileContentsPromises)

	const validFileContents = fileContents.filter((content) => content !== null).join("\n\n")

	if (validFileContents) {
		return `Files attached by the user:\n\n${validFileContents}`
	}

	// returns empty string if no files were loaded properly
	return ""
}
