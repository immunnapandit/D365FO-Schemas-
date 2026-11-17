// Lazy-loaded: Monaco is bundled locally (no CDN), so it also works on office networks.
import * as monaco from 'monaco-editor'
import Editor, { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import { useEffect } from 'react'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'json' ? new JsonWorker() : new EditorWorker()
  },
}

loader.config({ monaco })

interface Props {
  value: string
  onChange: (value: string) => void
  /** JSON Schema of a schema definition (from the server) for autocomplete + validation */
  schema?: object | null
  language?: 'json' | 'yaml'
}

export default function JsonEditor({ value, onChange, schema, language = 'json' }: Props) {
  useEffect(() => {
    monaco.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: false,
      enableSchemaRequest: false,
      schemas: schema ? [{ uri: 'inmemory://schema-definition.json', fileMatch: ['*'], schema }] : [],
    })
  }, [schema])

  return (
    <Editor
      language={language}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme="vs"
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        formatOnPaste: language === 'json',
        unicodeHighlight: { ambiguousCharacters: false },
      }}
    />
  )
}
