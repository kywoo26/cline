# Encoding Debug Build

This is a custom fork of Cline with encoding detection logging for debugging Chinese text output issues with Qwen models.

## Problem Description

When using Qwen models in Cline, Chinese text sometimes appears in responses unexpectedly.

**Hypothesis**: When Cline reads files using `@mention`, the `chardet` library may misdetect file encoding (e.g., detecting Korean EUC-KR files as Chinese GB2312). This causes garbled Chinese characters to be included in the model context, leading the model to respond in Chinese.

## Data Flow

```
User input: "@/some_file.txt analyze this"
                    │
                    ▼
        parseMentions() [mentions/index.ts]
                    │
                    ▼
        getFileOrFolderContent() [mentions/index.ts]
                    │
                    ▼
        extractTextFromFile() [extract-text.ts]
                    │
                    ▼
        detectEncoding() ──► chardet.detect()
                    │              │
                    │              ▼
                    │     Encoding detected (e.g., "GB2312")
                    │              │
                    ▼              ▼
        iconv.decode(buffer, encoding)
                    │
                    ▼
        Decoded text included in model context
                    │
                    ▼
        Model sees Chinese characters → responds in Chinese
```

## Changes Made

### 1. `src/integrations/misc/extract-text.ts`
Added selective encoding logging:
- Logs only suspicious cases (non-UTF8, low confidence, CJK encodings)
- Includes decoded preview (first 200 chars) for suspicious cases
- Rolling log files (max 5 files, 2MB each)
- Log location: `D:/cline_encoding_debug/`

### 2. `scripts/build-proto.mjs`
Modified to require `PROTOC_PATH` environment variable for builds.

### 3. `package.json`
- `displayName`: "Cline (Encoding Debug)"
- `version`: "3.45.0-encoding-debug.1"

## Building VSIX

### Prerequisites
1. Install protoc:
   - **Windows**: Download from https://github.com/protocolbuffers/protobuf/releases
   - **macOS**: `brew install protobuf`
   - **Linux**: `apt install protobuf-compiler`

2. Set environment variable:
   ```bash
   # Windows (PowerShell)
   $env:PROTOC_PATH = "C:\path\to\protoc.exe"

   # Windows (CMD)
   set PROTOC_PATH=C:\path\to\protoc.exe

   # macOS/Linux
   export PROTOC_PATH=/usr/local/bin/protoc
   ```

### Build Steps
```bash
# 1. Install dependencies
npm run install:all

# 2. Generate Protocol Buffer files
npm run protos

# 3. Build and package VSIX
npx vsce package --allow-package-secrets sendgrid
```

Output: `claude-dev-3.45.0-encoding-debug.1.vsix`

### Installation
```bash
code --install-extension claude-dev-3.45.0-encoding-debug.1.vsix
```

Or in VS Code: Extensions → `...` → "Install from VSIX..."

## Tracking Encoding Issues

### 1. When Issue Occurs
When Qwen model responds in Chinese unexpectedly:
- Note the approximate time
- Remember which files were `@mentioned`

### 2. Check Logs
```bash
cat D:/cline_encoding_debug/encoding_001.log
```

### 3. Log Format
```json
{
  "timestamp": "2025-12-18T18:30:00.000Z",
  "filePath": "C:/project/some_file.txt",
  "detected": {"encoding": "EUC-KR", "confidence": 0.7},
  "finalEncoding": "EUC-KR",
  "bufferSize": 1024,
  "firstBytes": "hex encoded first 100 bytes...",
  "decodedPreview": "First 200 chars of decoded text..."
}
```

### 4. What to Look For

| Field | Suspicious Signal |
|-------|-------------------|
| `encoding` | `GB2312`, `GB18030`, `Big5`, `GBK` for non-Chinese files |
| `confidence` | < 0.9 |
| `decodedPreview` | Contains garbled or Chinese characters |

### 5. Logging Conditions
Logs are written only when:
- Encoding is in suspicious list: `GB2312`, `GB18030`, `Big5`, `GBK`, `EUC-KR`, `EUC-JP`, `ISO-2022-JP`, `ISO-2022-KR`, `HZ-GB-2312`
- Confidence < 0.9
- Encoding is not UTF-8 or ASCII

Normal UTF-8/ASCII files are **not logged** to keep log files small.

## Next Steps After Finding Issues

If pattern is confirmed:
1. Document the actual file encoding vs detected encoding
2. Consider adding confidence threshold check
3. Consider UTF-8 fallback logic for low confidence cases
4. Report findings to Cline maintainers if applicable
