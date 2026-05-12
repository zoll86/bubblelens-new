// BubbleLens build script
// Összefűzi a forrás fájlokat → dist/index.html
const fs = require('fs')
const path = require('path')

fs.mkdirSync('dist', { recursive: true })

// Forrás fájlok beolvasása
const head  = fs.readFileSync('src/head.html',   'utf-8')
const css   = fs.readFileSync('styles/main.css', 'utf-8')
const body  = fs.readFileSync('src/body.html',   'utf-8')
const js    = fs.readFileSync('src/main.js',     'utf-8')

// HTML összerakása
const html = `<!DOCTYPE html>
<html lang="hu">
<head>
${head}
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>`

fs.writeFileSync('dist/index.html', html, 'utf-8')

const kb = (fs.statSync('dist/index.html').size / 1024).toFixed(0)
console.log(`✓ dist/index.html (${kb} KB)`)
