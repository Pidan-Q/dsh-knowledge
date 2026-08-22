/**
 * 客户端包浏览器面构建：esbuild 把 src/client/index.ts 打成
 * window.__ModuleLoader__.load({ id, factory: (require) => ... }) 格式的
 * lib/client.js（与官方 tsdown clientBundle 产物同构），供 web 端
 * /plugins/<id>/client.js 加载。
 *
 * 约定：react / react/jsx-runtime / react-dom 为 external（web 端模块表
 * 提供，官方 client.js 同款）；zod 等运行时依赖内联打包。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packages = ['knowledge', 'client-ui-errata']

for (const pkg of packages) {
  const dir = join(root, 'packages', pkg)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const result = await build({
    entryPoints: [join(dir, 'src/client/index.ts')],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    jsx: 'automatic',
    target: 'es2022',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*'],
    outfile: join(dir, 'lib/_bundle.js'),
    write: false,
    sourcemap: false,
  })
  const code = result.outputFiles[0].text.trim()
  const indent = (text) => text.split('\n').map((l) => `\t\t${l}`).join('\n')
  const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(manifest.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${indent(code)}\n\t\treturn module.exports;\n\t}\n});\n`
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib/client.js'), wrapped)
  console.log(`built ${manifest.name} -> lib/client.js (${wrapped.length} bytes)`)
}
