const fs=require('fs');
let h=fs.readFileSync('index.src.html','utf8');
h=h.replace('/*ENGINE*/',()=>fs.readFileSync('engine.js','utf8')).replace('/*GAME*/',()=>fs.readFileSync('game.js','utf8'));
fs.mkdirSync('dist',{recursive:true});
fs.writeFileSync('dist/index.html',h);
// local preview with skeleton
fs.writeFileSync('dist/preview.html','<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>'+h+'</body></html>');

// public web build (GitHub Pages): full document + Firebase SDK + config
const cfg = fs.existsSync('firebase-config.js') ? fs.readFileSync('firebase-config.js','utf8') : 'window.FIREBASE_CONFIG = null;';
fs.mkdirSync('dist/web',{recursive:true});
fs.writeFileSync('dist/web/index.html','<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a111d"><style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
 + '<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script><script>'+cfg+'</script></head><body>'+h+'</body></html>');
