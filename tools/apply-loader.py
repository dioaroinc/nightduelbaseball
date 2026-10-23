# Copies loader.html into every page and makes the font stylesheet non-blocking.
# Run from the repo root: python3 tools/apply-loader.py  (then node build.js for baseball)
import re
snip = open('loader.html').read().strip()
pages = ['index.html', 'tennis/index.html', 'clay/index.html', 'bowling/index.html', 'soccer/index.html', 'basketball/index.html', 'index.src.html']
for path in pages:
    s = open(path).read()
    s = re.sub(r'<!--LOADER.*?<!--/LOADER-->\n?', '', s, flags=re.S)
    if path == 'index.src.html':
        s = snip + '\n' + s
    else:
        s = s.replace('<body>\n', '<body>\n' + snip + '\n', 1)
    # fonts: load the stylesheet without blocking the first paint
    # (skips the copy already inside <noscript>, so running this again changes nothing)
    s = re.sub(r'(?<!<noscript>)<link rel="stylesheet" href="(https://fonts\.googleapis\.com/[^"]+)">',
               r'''<link rel="preload" as="style" href="\1" onload="this.onload=null;this.rel='stylesheet'"><noscript><link rel="stylesheet" href="\1"></noscript>''', s)
    # small shared scripts: run after parsing instead of holding up the page
    s = re.sub(r'<script src="((?:\.\./)?(?:firebase-config|track)\.js)"></script>', r'<script defer src="\1"></script>', s)
    open(path, 'w').write(s)
    print(path, s.count('id="ldr"'), s.count('rel="preload" as="style"'), s.count('<script defer'))
