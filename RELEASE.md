# Release walkthrough

## 1. Squash entire git history to one commit

**Option A – Orphan branch (recommended, one clean commit):**

```bash
# Create a new branch with no history
git checkout --orphan temp-main

# Stage everything (same as current main)
git add -A
git commit -m "Initial commit: ideacode v1"

# Replace main with this single-commit history
git branch -D main
git branch -m main

# If you already have a remote and had pushed before, update it (rewrites history):
# git push -f origin main
```

**Option B – Soft reset (keep same tree, squash onto root):**

```bash
# Point branch at root commit but keep all files staged
git reset --soft $(git rev-list --max-parents=0 HEAD)
git commit -m "Initial commit: ideacode v1"
# If pushed before: git push -f origin main
```

---

## 2. Tag v1

```bash
git tag v1
# Or annotated (recommended for releases):
git tag -a v1 -m "Release v1.0.0"

# Push the tag (after you've pushed main):
git push origin v1
```

---

## 3. Release on npm

**Prereqs:** npm account, logged in (`npm whoami`).

1. **Name:** Package name is `ideacode`. If it’s taken on npm, use a scope: in `package.json` set `"name": "@YOUR_NPM_USERNAME/ideacode"`.

2. **Version:** You already have `"version": "1.0.0"` in package.json. Optional: `npm version 1.0.0` (no change) or leave as-is.

3. **Files published:** By default npm publishes everything except what’s in `.gitignore`. To restrict to `dist/` and key files, add a `"files"` field in package.json, e.g.:
   ```json
   "files": ["dist", "README.md"]
   ```

4. **Build before publish:** Ensure `dist/` is up to date:
   ```bash
   npm run build
   ```

5. **Publish:**
   ```bash
   npm publish
   ```
   If you use a scope and want it public:
   ```bash
   npm publish --access public
   ```

6. **Tag on npm (optional):** Your git tag is separate. To tag the version on npm: `npm dist-tag add ideacode@1.0.0 latest`

---

## Quick sequence (after squash + tag)

```bash
npm run build
npm whoami          # confirm logged in
npm publish         # or: npm publish --access public (for scoped packages)
git push origin main
git push origin v1
```
