# Publishing

```bash
# 1. Commit all changes
git add . && git commit -m "your changes"

# 2. Bump version (creates tag and pushes)
npm version patch   # 0.0.1 -> 0.0.2
npm version minor   # 0.0.1 -> 0.1.0
npm version major   # 0.0.1 -> 1.0.0

# 3. Preview package contents
npm pack --dry-run

# 4. Publish
npm publish
```

Pre-release:
```bash
npm version prerelease --preid=beta && npm publish --tag beta
```
