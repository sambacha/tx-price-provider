import dts from 'rollup-plugin-dts'
import esbuild from 'rollup-plugin-esbuild'
import typescript from 'rollup-plugin-typescript2';

const bundle = (config) => ({
  ...config,
  input: 'src/index.ts',
  external: (id) => !/^[./]/.test(id)
})

export default [
  bundle({
    plugins: [
        typescript(/*{ plugin options }*/),,
        esbuild()],
    output: [
      {
        file: `dist/index.cjs`,
        format: 'cjs',
        sourcemap: true
      },
      {
        file: `dist/index.mjs`,
        format: 'es',
        sourcemap: true
      }
    ]
  }),
  bundle({
    plugins: [
        typescript(/*{ plugin options }*/),
        dts()],
    output: {
      file: `dist/index.d.ts`,
      format: 'es'
    }
  })
]