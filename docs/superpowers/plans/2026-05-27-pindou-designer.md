# 拼豆设计图生成网站 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a browser-only image-to-bead-pattern MVP.

**Architecture:** Vite + React + TypeScript SPA. Domain modules are pure TypeScript and tested with Vitest; React components orchestrate uploads, settings, conversion, preview, statistics, and exports. Deployment is static files served by Nginx.

**Tech Stack:** React 18, Vite, TypeScript, Vitest, Canvas API, Nginx.

---

### Task 1: Project scaffold and tests

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/test/domain.test.ts`

- [ ] Create Node/Vite config files.
- [ ] Write domain tests before production modules.
- [ ] Run `npm test -- --run` and confirm failures are missing module failures.

### Task 2: Domain modules

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/color.ts`
- Create: `src/domain/boards.ts`
- Create: `src/domain/palette.ts`
- Create: `src/domain/conversion.ts`
- Create: `src/domain/exporters.ts`

- [ ] Implement the minimum pure logic required by tests.
- [ ] Run `npm test -- --run` and confirm tests pass.

### Task 3: React UI

**Files:**
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/components/*.tsx`
- Create: `src/styles.css`

- [ ] Implement upload/settings/preview/statistics/export UI.
- [ ] Run `npm run build`.

### Task 4: Deploy

**Files:**
- Create: `deploy/nginx-image2pindou.conf`

- [ ] Build local `dist/`.
- [ ] Upload `dist/` to `/var/www/image2pindou/`.
- [ ] Install/update Nginx site config.
- [ ] Reload Nginx.
- [ ] Verify `http://203.0.113.10/`.
