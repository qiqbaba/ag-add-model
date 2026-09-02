/**
 * Web Dashboard HTML & UI Renderer for Antigravity Model Configuration & Connectivity Testing.
 *
 * Self-contained, zero-dependency, rich single-page application with modern dark aesthetics,
 * real-time schema validation, provider presets, and connectivity diagnostics.
 */

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Antigravity 模型配置与连通性管理面板</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%236366f1'><path d='M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'/></svg>">
  <style>
    :root {
      --bg-base: #0a0d14;
      --bg-surface: #111726;
      --bg-surface-elevated: #182238;
      --bg-card: rgba(20, 28, 48, 0.7);
      --bg-card-hover: rgba(28, 40, 68, 0.85);
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border-medium: rgba(255, 255, 255, 0.16);
      --border-focus: #6366f1;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-indigo: #6366f1;
      --accent-violet: #8b5cf6;
      --accent-cyan: #06b6d4;
      --accent-emerald: #10b981;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
      --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.4);
      --shadow-glow: 0 0 20px rgba(99, 102, 241, 0.25);
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --radius-full: 9999px;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: "Fira Code", "Cascadia Code", Consolas, Monaco, "Courier New", monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-base);
      color: var(--text-primary);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.5;
      overflow-x: hidden;
      background-image: 
        radial-gradient(ellipse 80% 50% at 50% -20%, rgba(99, 102, 241, 0.15), transparent),
        radial-gradient(ellipse 60% 40% at 100% 100%, rgba(139, 92, 246, 0.08), transparent);
    }

    /* ─── Header ─────────────────────────────────────────── */
    header {
      background: rgba(17, 23, 38, 0.8);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 40;
      padding: 12px 24px;
    }

    .header-inner {
      max-width: 1380px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-logo {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--accent-indigo), var(--accent-violet));
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow-glow);
    }

    .brand-title {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-badge {
      font-size: 0.7rem;
      padding: 2px 8px;
      border-radius: var(--radius-full);
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
      font-weight: 600;
    }

    .status-pills {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .pill {
      font-size: 0.78rem;
      padding: 4px 10px;
      border-radius: var(--radius-full);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .pill.success {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }

    .dot-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--accent-emerald);
      box-shadow: 0 0 8px var(--accent-emerald);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* ─── Buttons ────────────────────────────────────────── */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      outline: none;
      text-decoration: none;
      user-select: none;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent-indigo), var(--accent-violet));
      color: #fff;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
    }
    .btn-primary:hover {
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.6);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.07);
      border-color: var(--border-subtle);
      color: var(--text-primary);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: var(--border-medium);
    }

    .btn-success {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.4);
      color: #6ee7b7;
    }
    .btn-success:hover {
      background: rgba(16, 185, 129, 0.25);
    }

    .btn-danger {
      background: rgba(244, 63, 94, 0.12);
      border-color: rgba(244, 63, 94, 0.3);
      color: #fda4af;
    }
    .btn-danger:hover {
      background: rgba(244, 63, 94, 0.25);
    }

    .btn-sm {
      padding: 4px 9px;
      font-size: 0.78rem;
    }

    /* ─── Main Container ─────────────────────────────────── */
    main {
      max-width: 1380px;
      margin: 0 auto;
      padding: 24px;
      flex: 1;
      width: 100%;
    }

    /* ─── Presets Toolbar ────────────────────────────────── */
    .presets-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      margin-bottom: 24px;
      box-shadow: var(--shadow-sm);
    }

    .presets-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .presets-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .preset-chip {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-full);
      padding: 6px 14px;
      font-size: 0.8rem;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .preset-chip:hover {
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.4);
      color: #c7d2fe;
      transform: translateY(-1px);
    }

    /* Presets card embedded inside the Add/Edit model modal */
    .presets-card.modal-presets {
      margin-bottom: 0;
      padding: 12px 14px;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border-subtle);
    }
    .presets-card.modal-presets .presets-title {
      margin-bottom: 10px;
    }
    .presets-card.modal-presets .preset-chip {
      padding: 5px 12px;
      font-size: 0.78rem;
    }

    /* ─── Controls Bar ───────────────────────────────────── */
    .controls-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .search-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 260px;
      max-width: 460px;
    }

    .input-wrapper {
      position: relative;
      width: 100%;
    }

    .input-icon {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      pointer-events: none;
    }

    .form-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 8px 12px 8px 34px;
      font-size: 0.85rem;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .form-input:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
    }

    .form-select {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 8px 12px;
      font-size: 0.85rem;
      outline: none;
      cursor: pointer;
    }
    .form-select:focus {
      border-color: var(--border-focus);
    }

    /* ─── Model Cards Grid ───────────────────────────────── */
    .models-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
      gap: 20px;
    }

    .model-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 20px;
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 16px;
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .model-card:hover {
      background: var(--bg-card-hover);
      border-color: rgba(99, 102, 241, 0.3);
      box-shadow: var(--shadow-md);
      transform: translateY(-2px);
    }

    .model-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .model-name-group {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .model-display-name {
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .model-internal-name {
      font-size: 0.76rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }

    .provider-badge {
      font-size: 0.72rem;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .provider-badge.openai { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .provider-badge.anthropic { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .provider-badge.deepseek { background: rgba(6, 182, 212, 0.15); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.3); }
    .provider-badge.ollama { background: rgba(139, 92, 246, 0.15); color: #c084fc; border: 1px solid rgba(139, 92, 246, 0.3); }
    .provider-badge.google { background: rgba(236, 72, 153, 0.15); color: #f472b6; border: 1px solid rgba(236, 72, 153, 0.3); }
    .provider-badge.custom { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.3); }

    .model-meta-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 0.8rem;
      color: var(--text-secondary);
      background: rgba(0, 0, 0, 0.25);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, 0.03);
    }

    .meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .meta-label {
      color: var(--text-muted);
      font-size: 0.75rem;
      min-width: 80px;
    }

    .meta-val {
      font-family: var(--font-mono);
      font-size: 0.76rem;
      color: #cbd5e1;
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 250px;
    }

    .caps-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .cap-tag {
      font-size: 0.7rem;
      padding: 2px 7px;
      border-radius: var(--radius-full);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }

    .cap-tag.active-thinking {
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
    }

    .cap-tag.active-vision {
      background: rgba(6, 182, 212, 0.15);
      border-color: rgba(6, 182, 212, 0.4);
      color: #67e8f9;
    }

    /* ─── Test Result Box ────────────────────────────────── */
    .test-result-box {
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      font-size: 0.78rem;
      display: none;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .test-result-box.testing {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
    }

    .test-result-box.success {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }

    .test-result-box.error {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: #fda4af;
    }

    .test-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
    }

    .test-detail {
      font-size: 0.74rem;
      opacity: 0.9;
      line-height: 1.4;
      word-break: break-word;
    }

    .test-reply {
      font-family: var(--font-mono);
      font-size: 0.72rem;
      background: rgba(0, 0, 0, 0.3);
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      margin-top: 2px;
      color: #e2e8f0;
    }

    .model-card-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 10px;
      border-top: 1px solid var(--border-subtle);
    }

    /* ─── Empty State ────────────────────────────────────── */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      background: var(--bg-surface);
      border: 1px dashed var(--border-medium);
      border-radius: var(--radius-lg);
      grid-column: 1 / -1;
    }

    .empty-icon {
      width: 48px;
      height: 48px;
      margin: 0 auto 12px;
      color: var(--text-muted);
    }

    .empty-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 6px;
    }

    .empty-desc {
      font-size: 0.85rem;
      color: var(--text-muted);
      max-width: 400px;
      margin: 0 auto 16px;
    }

    /* ─── Modal System ───────────────────────────────────── */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease;
    }

    .modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }

    .modal-container {
      background: var(--bg-surface);
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 620px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-lg);
      transform: scale(0.96) translateY(8px);
      transition: transform 0.2s ease;
      overflow: hidden;
    }

    .modal-overlay.open .modal-container {
      transform: scale(1) translateY(0);
    }

    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-size: 1.1rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-close:hover {
      color: var(--text-primary);
      background: rgba(255, 255, 255, 0.08);
    }

    .modal-body {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .modal-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border-subtle);
      background: rgba(0, 0, 0, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    /* ─── Form Controls ──────────────────────────────────── */
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .form-hint {
      font-size: 0.74rem;
      color: var(--text-muted);
    }

    .form-control {
      width: 100%;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      padding: 9px 12px;
      font-size: 0.86rem;
      outline: none;
      transition: all 0.15s ease;
    }

    .form-control:focus {
      border-color: var(--border-focus);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
    }

    .password-wrapper {
      position: relative;
      display: flex;
    }

    .password-wrapper .form-control {
      padding-right: 40px;
    }

    /* ─── Discovered Model (batch-add) List ─────────────── */
    .discovered-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 200px;
      overflow-y: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      padding: 6px;
      margin-top: 4px;
    }
    .discovered-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px;
      border-radius: 4px;
      background: var(--bg-surface-elevated);
      font-size: 0.8rem;
    }
    .discovered-item.exists {
      opacity: 0.6;
    }
    .discovered-item input[type="checkbox"] {
      accent-color: var(--accent-indigo);
      flex-shrink: 0;
    }
    .discovered-label {
      flex: 1;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .discovered-badge {
      font-size: 0.68rem;
      color: var(--accent-emerald);
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 10px;
      padding: 1px 8px;
      flex-shrink: 0;
    }
    .discovered-apply {
      background: none;
      border: none;
      color: var(--accent-cyan);
      font-size: 0.74rem;
      cursor: pointer;
      flex-shrink: 0;
      padding: 2px 4px;
    }
    .discovered-apply:hover {
      text-decoration: underline;
    }
    .discovered-actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
      flex-wrap: wrap;
    }

    .toggle-pwd-btn {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
    }
    .toggle-pwd-btn:hover {
      color: var(--text-primary);
    }

    .accordion-toggle {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      color: var(--text-secondary);
      font-size: 0.82rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
    }

    .accordion-content {
      display: none;
      padding: 12px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 0 0 var(--radius-sm) var(--radius-sm);
      border: 1px solid var(--border-subtle);
      border-top: none;
      flex-direction: column;
      gap: 12px;
    }

    .accordion-content.open {
      display: flex;
    }

    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 0.82rem;
      color: var(--text-secondary);
    }

    /* ─── Toast System ───────────────────────────────────── */
    #toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }

    .toast {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-medium);
      color: var(--text-primary);
      padding: 12px 18px;
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg);
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 280px;
      max-width: 420px;
      pointer-events: auto;
      animation: slideUp 0.25s ease;
    }

    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .toast.success { border-color: rgba(16, 185, 129, 0.5); background: #06281e; }
    .toast.error { border-color: rgba(244, 63, 94, 0.5); background: #300d14; }
    .toast.info { border-color: rgba(99, 102, 241, 0.5); background: #131738; }

    /* ─── Spinner ────────────────────────────────────────── */
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      display: inline-block;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ─── Raw JSON Area ──────────────────────────────────── */
    .raw-textarea {
      width: 100%;
      height: 380px;
      background: #080c14;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      color: #a5f3fc;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      padding: 12px;
      line-height: 1.4;
      outline: none;
      resize: vertical;
      white-space: pre;
    }

    /* ─── Help Drawer Table ──────────────────────────────── */
    .guide-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      margin-top: 8px;
    }
    .guide-table th, .guide-table td {
      border: 1px solid var(--border-subtle);
      padding: 8px 12px;
      text-align: left;
    }
    .guide-table th {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-secondary);
    }

    @media (max-width: 768px) {
      .models-grid { grid-template-columns: 1fr; }
      .header-inner { flex-direction: column; align-items: flex-start; }
      .status-pills { width: 100%; }
    }
  </style>
</head>
<body>

  <!-- ─── Header ───────────────────────────────────────────── -->
  <header>
    <div class="header-inner">
      <div class="brand-group">
        <div class="brand-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
        </div>
        <div>
          <div class="brand-title">
            Antigravity Models
            <span class="brand-badge">Standalone IDE</span>
          </div>
        </div>
      </div>

      <div class="status-pills">
        <div class="pill success" id="pill-proxy-status">
          <span class="dot-pulse"></span>
          <span>代理监听中: <strong id="lbl-proxy-port">50999</strong></span>
        </div>
        <div class="pill" id="pill-model-count">
          <span>已加载模型: <strong id="lbl-model-count">0</strong></span>
        </div>
        <div class="pill" id="pill-encryption-status">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span id="lbl-encryption-text">safeStorage 加密保护</span>
        </div>
      </div>

      <div class="header-actions">
        <button id="btn-test-all" class="btn btn-secondary" onclick="runTestAll()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          一键测速全部
        </button>
        <button id="btn-open-add-model" class="btn btn-primary" onclick="openAddModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          添加模型
        </button>
        <button id="btn-open-raw-json" class="btn btn-secondary" onclick="openRawModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
          Raw JSON
        </button>
        <button id="btn-open-help" class="btn btn-secondary" onclick="openHelpModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          使用帮助
        </button>
      </div>
    </div>
  </header>

  <!-- ─── Main Content ─────────────────────────────────────── -->
  <main>
    <!-- Search & Filter Controls -->
    <div class="controls-bar">
      <div class="search-group">
        <div class="input-wrapper">
          <svg class="input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" id="input-search" class="form-input" placeholder="搜索模型名称、显示名或 Provider..." oninput="renderModels()" />
        </div>
        <select id="select-provider-filter" class="form-select" onchange="renderModels()">
          <option value="all">全部 Provider</option>
          <option value="openai">OpenAI 协议</option>
          <option value="anthropic">Anthropic</option>
          <option value="ollama">Ollama</option>
          <option value="google">Google</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      <div style="font-size: 0.8rem; color: var(--text-muted);">
        配置文件: <code id="lbl-config-path" style="font-family: var(--font-mono); color: var(--text-secondary);">~/.gemini/antigravity/custom_models.json</code>
      </div>
    </div>

    <!-- Models List Grid -->
    <div id="models-container" class="models-grid">
      <!-- Injected via JavaScript -->
    </div>
  </main>

  <!-- ─── Modal: Add / Edit Model ─────────────────────────── -->
  <div id="modal-model-form" class="modal-overlay">
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
          <span id="form-modal-title">添加自定义模型</span>
        </div>
        <button class="modal-close" onclick="closeAddModal()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body">
        <!-- Quick Presets (merged from main page) -->
        <div class="presets-card modal-presets">
          <div class="presets-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
            快速预设模板 (点击快速填表)
          </div>
          <div class="presets-grid">
            <button class="preset-chip" onclick="applyPreset('deepseek')">
              <span>🚀</span> DeepSeek 官方
            </button>
            <button class="preset-chip" onclick="applyPreset('deepseek-r1')">
              <span>🧠</span> DeepSeek-R1 深度思考
            </button>
            <button class="preset-chip" onclick="applyPreset('openai-gpt4o')">
              <span>⚡</span> OpenAI GPT-4o
            </button>
            <button class="preset-chip" onclick="applyPreset('anthropic-claude')">
              <span>👑</span> Claude 3.5 Sonnet
            </button>
            <button class="preset-chip" onclick="applyPreset('ollama-local')">
              <span>🦙</span> Ollama 本地模型
            </button>
            <button class="preset-chip" onclick="applyPreset('openrouter')">
              <span>🌐</span> OpenRouter 聚合
            </button>
            <button class="preset-chip" onclick="applyPreset('siliconflow')">
              <span>⚡</span> 硅基流动 SiliconFlow
            </button>
            <button class="preset-chip" onclick="applyPreset('sensenova')">
              <span>🌌</span> 商汤日日新 SenseNova
            </button>
            <button class="preset-chip" onclick="applyPreset('moonshot')">
              <span>🌙</span> 月之暗面 Kimi
            </button>
            <button class="preset-chip" onclick="applyPreset('google-ai')">
              <span>🔮</span> Google AI Studio
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>协议翻译器 (Provider) <span style="color: var(--accent-rose)">*</span></span>
            <span class="form-hint" style="color: var(--accent-amber)">所有兼容 /v1/chat/completions 的厂商请填 openai</span>
          </label>
          <select id="form-provider" class="form-control" onchange="handleProviderChange()">
            <option value="openai">openai (OpenAI 协议: DeepSeek, SiliconFlow, SenseNova, Moonshot, Groq 等)</option>
            <option value="anthropic">anthropic (Anthropic 协议: Claude 系列)</option>
            <option value="ollama">ollama (本地 Ollama 服务)</option>
            <option value="google">google (Google AI Studio 直连)</option>
            <option value="custom">custom (自定义兼容协议)</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>完整 API URL <span style="color: var(--accent-rose)">*</span></span>
            <span class="form-hint">需包含完整端点路径</span>
          </label>
          <div style="display: flex; gap: 8px;">
          <input type="text" id="form-api-url" class="form-control" placeholder="例如: https://api.deepseek.com/v1/chat/completions" style="flex: 1;" />
          <button type="button" id="btn-discover-models" class="btn btn-secondary" onclick="discoverModelsFromUrl()">自动获取模型</button>
        </div>
        <div id="discovered-model-list" class="discovered-list" style="display: none;"></div>
        <div id="discovered-model-actions" class="discovered-actions" style="display: none;">
          <button type="button" class="btn btn-secondary" onclick="selectAllDiscovered()" id="btn-select-all">全选未添加</button>
          <button type="button" class="btn btn-secondary" onclick="clearDiscoveredSelection()">取消全选</button>
          <button type="button" class="btn btn-primary" onclick="batchAddDiscovered()" id="btn-batch-add">批量添加所选 (0)</button>
        </div>
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>API Key / 访问令牌</span>
            <span class="form-hint" id="form-key-hint">将自动使用 safeStorage 加密存储</span>
          </label>
          <div class="password-wrapper">
            <input type="password" id="form-api-key" class="form-control" placeholder="sk-..." />
            <button type="button" class="toggle-pwd-btn" onclick="togglePasswordVisibility('form-api-key')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>显示名称 (Display Name) <span style="color: var(--accent-rose)">*</span></span>
            <span class="form-hint">IDE 模型选择器中展示的名称</span>
          </label>
          <input type="text" id="form-display-name" class="form-control" placeholder="例如: DeepSeek-V3 (官方 API)" oninput="autoDeriveNames()" />
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>内部模型标识 (Name) <span style="color: var(--accent-rose)">*</span></span>
            <span class="form-hint">必须以 models/ 开头（可通过上方「自动获取模型」自动填充）</span>
          </label>
          <input type="text" id="form-name" class="form-control" placeholder="例如: models/deepseek-v3" />
        </div>

        <div class="form-group">
          <label class="form-label">
            <span>外部模型名称 (External Model Name) <span style="color: var(--accent-rose)">*</span></span>
            <span class="form-hint">发送给上游 API 的实际 model 参数</span>
          </label>
          <input type="text" id="form-external-name" class="form-control" placeholder="例如: deepseek-chat, gpt-4o, claude-3-5-sonnet-20241022" />
        </div>

        <!-- Advanced Options Accordion -->
        <div class="form-group">
          <div class="accordion-toggle" onclick="toggleAccordion('adv-options')">
            <span>高级选项 (SSL 证书绕过 / 自定义超时 / 重试次数)</span>
            <span id="adv-arrow">▼</span>
          </div>
          <div id="adv-options" class="accordion-content">
            <label class="checkbox-group">
              <input type="checkbox" id="form-allow-unauthorized" />
              <span>允许自签名 SSL 证书 (仅在局域网自建服务且证书未受信任时勾选)</span>
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div class="form-group">
                <label class="form-label">请求超时 (毫秒)</label>
                <input type="number" id="form-timeout" class="form-control" placeholder="默认: 120000" />
              </div>
              <div class="form-group">
                <label class="form-label">失败重试次数 (0-5)</label>
                <input type="number" id="form-max-retries" class="form-control" placeholder="默认: 3" min="0" max="5" />
              </div>
            </div>
          </div>
        </div>

        <!-- In-Modal Test Result Box -->
        <div id="form-test-result" class="test-result-box"></div>
      </div>

      <div class="modal-footer">
        <button type="button" id="btn-modal-test" class="btn btn-secondary" onclick="testCurrentForm()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
          连通性测试
        </button>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary" onclick="closeAddModal()">取消</button>
          <button type="button" id="btn-modal-save" class="btn btn-primary" onclick="submitModelForm()">保存模型</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ─── Modal: Raw JSON Editor ───────────────────────────── -->
  <div id="modal-raw-json" class="modal-overlay">
    <div class="modal-container" style="max-width: 780px;">
      <div class="modal-header">
        <div class="modal-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
          <span>Raw custom_models.json 编辑器</span>
        </div>
        <button class="modal-close" onclick="closeRawModal()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="font-size: 0.8rem; color: var(--text-muted);">
          提示：保存时会自动执行 Schema 格式与字段校验，并通过 safeStorage 重新加密未加密的 API 密钥。
        </p>
        <textarea id="raw-json-textarea" class="raw-textarea" spellcheck="false"></textarea>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick="formatRawJson()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="21" y1="10" x2="3" y2="10"></line><line x1="21" y1="6" x2="3" y2="6"></line><line x1="21" y1="14" x2="3" y2="14"></line><line x1="21" y1="18" x2="3" y2="18"></line></svg>
          格式化 JSON
        </button>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-secondary" onclick="closeRawModal()">取消</button>
          <button type="button" id="btn-save-raw" class="btn btn-primary" onclick="saveRawJson()">校验并保存</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ─── Modal: Help & Diagnostic Guide ───────────────────── -->
  <div id="modal-help" class="modal-overlay">
    <div class="modal-container" style="max-width: 720px;">
      <div class="modal-header">
        <div class="modal-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          <span>Antigravity 自定义模型接入指南</span>
        </div>
        <button class="modal-close" onclick="closeHelpModal()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="modal-body" style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.6;">
        <h4 style="color: var(--text-primary); margin-bottom: 4px;">1. Provider 字段填写规则（重点避坑 9）</h4>
        <p>
          <code>provider</code> 代表的是<strong>协议转换器类型</strong>，不是厂商品牌名。
        </p>
        <table class="guide-table">
          <thead>
            <tr><th>厂商 / 平台</th><th>provider 必须填写</th><th>apiUrl 示例</th></tr>
          </thead>
          <tbody>
            <tr><td>DeepSeek 官方</td><td><code>openai</code></td><td><code>https://api.deepseek.com/v1/chat/completions</code></td></tr>
            <tr><td>硅基流动 / 商汤 / 月之暗面</td><td><code>openai</code></td><td>各平台的 <code>/v1/chat/completions</code> 路径</td></tr>
            <tr><td>Anthropic Claude</td><td><code>anthropic</code></td><td><code>https://api.anthropic.com/v1/messages</code></td></tr>
            <tr><td>Ollama 本地大模型</td><td><code>ollama</code></td><td><code>http://localhost:11434/v1/chat/completions</code></td></tr>
            <tr><td>Google AI Studio</td><td><code>google</code></td><td><code>https://generativelanguage.googleapis.com/v1beta</code></td></tr>
          </tbody>
        </table>

        <h4 style="color: var(--text-primary); margin-top: 16px; margin-bottom: 4px;">2. 在 Antigravity IDE 中如何选用模型？</h4>
        <p>
          在此面板添加并保存模型后，代理服务会<strong>实时热更新</strong>。在 IDE 独立版的聊天对话框中，展开底部模型选择器下拉列表，你添加的自定义模型将直接出现在列表中，选中即可直接对话与调用工具。
        </p>

        <h4 style="color: var(--text-primary); margin-top: 16px; margin-bottom: 4px;">3. 连通性测试报错快速排查</h4>
        <ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 4px;">
          <li><strong>401 Unauthorized</strong>: API 密钥错误或已失效。</li>
          <li><strong>404 Not Found</strong>: API URL 缺少 <code>/v1/chat/completions</code>，或 <code>externalModelName</code> 拼写错误。</li>
          <li><strong>429 Too Many Requests</strong>: 账户额度耗尽或请求超频。</li>
          <li><strong>ECONNREFUSED</strong>: 本地 Ollama 未启动或端口填写有误。</li>
        </ul>
      </div>
      <div class="modal-footer">
        <div></div>
        <button type="button" class="btn btn-primary" onclick="closeHelpModal()">我知道了</button>
      </div>
    </div>
  </div>

  <!-- ─── Toast Container ──────────────────────────────────── -->
  <div id="toast-container"></div>

  <!-- ─── Application Logic ────────────────────────────────── -->
  <script>
    let state = {
      models: [],
      systemInfo: null,
      editingIndex: -1,
      lastDiscovered: [],
    };

    // ─── Initialize ──────────────────────────────────────────
    window.addEventListener('DOMContentLoaded', async () => {
      await fetchSystemStatus();
      await fetchModels();
    });

    // ─── API Requests ────────────────────────────────────────
    async function fetchSystemStatus() {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          state.systemInfo = await res.json();
          updateHeaderStatus();
        }
      } catch (e) {
        console.error('Failed to fetch status:', e);
      }
    }

    async function fetchModels() {
      try {
        const res = await fetch('/api/models');
        if (res.ok) {
          state.models = await res.json();
          document.getElementById('lbl-model-count').textContent = state.models.length;
          renderModels();
        }
      } catch (e) {
        showToast('获取模型列表失败: ' + e.message, 'error');
      }
    }

    function updateHeaderStatus() {
      if (!state.systemInfo) return;
      document.getElementById('lbl-proxy-port').textContent = state.systemInfo.proxyPort || '50999';
      document.getElementById('lbl-config-path').textContent = state.systemInfo.customModelsPath || '~/.gemini/antigravity/custom_models.json';
      const encText = document.getElementById('lbl-encryption-text');
      if (state.systemInfo.encryptionAvailable) {
        encText.textContent = 'safeStorage 加密保护';
      } else {
        encText.textContent = 'Base64 兼容存储';
      }
    }

    // ─── Render Models ───────────────────────────────────────
    function renderModels() {
      const container = document.getElementById('models-container');
      const search = (document.getElementById('input-search').value || '').toLowerCase().trim();
      const filterProvider = document.getElementById('select-provider-filter').value;

      const filtered = state.models.filter(m => {
        const matchesSearch = !search || 
          (m.displayName && m.displayName.toLowerCase().includes(search)) ||
          (m.name && m.name.toLowerCase().includes(search)) ||
          (m.externalModelName && m.externalModelName.toLowerCase().includes(search)) ||
          (m.provider && m.provider.toLowerCase().includes(search));
        
        const matchesProvider = filterProvider === 'all' || m.provider === filterProvider;
        return matchesSearch && matchesProvider;
      });

      if (filtered.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="8" y1="12" x2="16" y2="12"></line></svg>
            <div class="empty-title">\${search || filterProvider !== 'all' ? '未找到符合条件的模型' : '尚未添加自定义模型'}</div>
            <div class="empty-desc">\${search || filterProvider !== 'all' ? '请尝试更换搜索关键字或 Provider 过滤选项。' : '你可以点击【添加模型】按钮，在弹窗中直接选用快速预设模板接入 DeepSeek、OpenAI、Claude 等大模型。'}</div>
            <button class="btn btn-primary" onclick="openAddModal()">立即添加模型</button>
          </div>
        \`;
        return;
      }

      container.innerHTML = filtered.map((m, idx) => {
        const provClass = ['openai', 'anthropic', 'deepseek', 'ollama', 'google'].includes(m.provider) ? m.provider : 'custom';
        const isThinking = m.capabilities && m.capabilities.isThinking;
        const isVision = m.capabilities && m.capabilities.supportsImages;

        return \`
          <div class="model-card" id="card-\${m.slug}">
            <div>
              <div class="model-card-header">
                <div class="model-name-group">
                  <div class="model-display-name">\${escapeHtml(m.displayName)}</div>
                  <div class="model-internal-name">\${escapeHtml(m.name)}</div>
                </div>
                <span class="provider-badge \${provClass}">\${escapeHtml(m.provider)}</span>
              </div>

              <div class="model-meta-list" style="margin-top: 12px;">
                <div class="meta-row">
                  <span class="meta-label">外部模型:</span>
                  <span class="meta-val">\${escapeHtml(m.externalModelName || '(同内部名称)')}</span>
                </div>
              </div>

              <div class="caps-group" style="margin-top: 10px;">
                \${isThinking ? '<span class="cap-tag active-thinking">🧠 深度思考</span>' : ''}
                \${isVision ? '<span class="cap-tag active-vision">🖼️ 视觉/多模态</span>' : ''}
                \${m.allowUnauthorized ? '<span class="cap-tag" style="border-color: rgba(245, 158, 11, 0.4); color: #fcd34d;">🔓 SSL Bypass</span>' : ''}
                \${m.encrypted ? '<span class="cap-tag">🔒 safeStorage 已加密</span>' : ''}
              </div>
            </div>

            <!-- Inline Test Result Box -->
            <div id="test-res-\${m.slug}" class="test-result-box"></div>

            <div class="model-card-actions">
              <button id="btn-test-\${m.slug}" class="btn btn-secondary btn-sm" onclick="testModel('\${escapeHtml(m.name)}', '\${m.slug}')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                测试连通性
              </button>
              <div style="display: flex; gap: 6px;">
                <button id="btn-edit-\${m.slug}" class="btn btn-secondary btn-sm" onclick="openEditModal('\${escapeHtml(m.name)}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                  编辑
                </button>
                <button id="btn-del-\${m.slug}" class="btn btn-danger btn-sm" onclick="deleteModel('\${escapeHtml(m.name)}')">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    // ─── Connectivity Testing ────────────────────────────────
    async function testModel(modelName, slug) {
      const box = document.getElementById('test-res-' + slug);
      const btn = document.getElementById('btn-test-' + slug);

      box.className = 'test-result-box testing';
      box.innerHTML = '<span class="spinner"></span> <span>正在向上游发送握手请求探测连通性...</span>';
      if (btn) btn.disabled = true;

      try {
        const res = await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName })
        });
        const result = await res.json();

        if (result.success) {
          box.className = 'test-result-box success';
          box.innerHTML = \`
            <div class="test-header">
              <span>🟢 连通正常 (HTTP \${result.statusCode || 200})</span>
              <span style="font-family: var(--font-mono)">\${result.latencyMs} ms</span>
            </div>
            <div class="test-detail">响应样例:</div>
            <div class="test-reply">\${escapeHtml(result.reply || 'OK')}</div>
          \`;
        } else {
          box.className = 'test-result-box error';
          box.innerHTML = \`
            <div class="test-header">
              <span>🔴 \${escapeHtml(result.error || '测试失败')}</span>
              <span style="font-family: var(--font-mono)">\${result.latencyMs} ms</span>
            </div>
            <div class="test-detail">\${escapeHtml(result.suggestion || result.details || '')}</div>
          \`;
        }
      } catch (err) {
        box.className = 'test-result-box error';
        box.innerHTML = \`
          <div class="test-header"><span>🔴 网络错误</span></div>
          <div class="test-detail">\${escapeHtml(err.message)}</div>
        \`;
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function runTestAll() {
      const btn = document.getElementById('btn-test-all');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 正在批量测速...';
      showToast('开始全量模型连通性探测...', 'info');

      for (const m of state.models) {
        await testModel(m.name, m.slug);
      }

      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg> 一键测速全部';
      showToast('全量模型测速完成！', 'success');
    }

    // ─── Modal & Form Operations ─────────────────────────────
    function openAddModal() {
      state.editingIndex = -1;
      document.getElementById('form-modal-title').textContent = '添加自定义模型';
      document.getElementById('form-display-name').value = '';
      document.getElementById('form-name').value = '';
      document.getElementById('form-external-name').value = '';
      document.getElementById('form-provider').value = 'openai';
      document.getElementById('form-api-url').value = '';
      document.getElementById('form-api-key').value = '';
      document.getElementById('form-key-hint').textContent = '将自动使用 safeStorage 加密存储';
      document.getElementById('form-allow-unauthorized').checked = false;
      document.getElementById('form-timeout').value = '';
      document.getElementById('form-max-retries').value = '';
      document.getElementById('form-test-result').style.display = 'none';
      document.getElementById('discovered-model-list').style.display = 'none';
      document.getElementById('discovered-model-actions').style.display = 'none';
      document.getElementById('discovered-model-list').innerHTML = '';
      state.lastDiscovered = [];

      document.getElementById('modal-model-form').classList.add('open');
    }

    async function openEditModal(modelName) {
      try {
        const res = await fetch('/api/models?includeKeys=true');
        const fullModels = await res.json();
        const m = fullModels.find(item => item.name === modelName);
        if (!m) return;

        state.editingIndex = state.models.findIndex(item => item.name === modelName);
        document.getElementById('form-modal-title').textContent = '编辑自定义模型';
        document.getElementById('form-display-name').value = m.displayName || '';
        document.getElementById('form-name').value = m.name || '';
        document.getElementById('form-external-name').value = m.externalModelName || '';
        document.getElementById('form-provider').value = m.provider || 'openai';
        document.getElementById('form-api-url').value = m.apiUrl || '';
        document.getElementById('form-api-key').value = m.apiKey || '';
        document.getElementById('form-key-hint').textContent = m.apiKey ? '已配置 API Key (如无需修改请留空或保持原样)' : '未配置 API Key';
        document.getElementById('form-allow-unauthorized').checked = !!m.allowUnauthorized;
        document.getElementById('form-timeout').value = m.timeout || '';
        document.getElementById('form-max-retries').value = m.maxRetries !== undefined ? m.maxRetries : '';
        document.getElementById('form-test-result').style.display = 'none';

        document.getElementById('modal-model-form').classList.add('open');
      } catch (e) {
        showToast('读取模型数据失败: ' + e.message, 'error');
      }
    }

    function closeAddModal() {
      document.getElementById('modal-model-form').classList.remove('open');
    }

    function autoDeriveNames() {
      if (state.editingIndex >= 0) return; // Don't overwrite when editing
      const disp = document.getElementById('form-display-name').value.trim();
      if (!disp) return;

      const slug = disp
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();

      const nameInput = document.getElementById('form-name');
      if (!nameInput.value || nameInput.value.startsWith('models/')) {
        nameInput.value = 'models/' + (slug || 'custom-model');
      }
    }

    async function discoverModelsFromUrl() {
      const box = document.getElementById('form-test-result');
      const list = document.getElementById('discovered-model-list');
      const actions = document.getElementById('discovered-model-actions');
      const btn = document.getElementById('btn-discover-models');
      const apiUrl = document.getElementById('form-api-url').value.trim();
      const apiKey = document.getElementById('form-api-key').value.trim();
      const provider = document.getElementById('form-provider').value;
      const allowUnauthorized = document.getElementById('form-allow-unauthorized').checked;

      // API Key is optional for discovery: keyless providers (e.g. local Ollama)
      // or endpoints that expose /models without auth are still discoverable.
      if (!apiUrl) { showToast('请先填写完整 API URL', 'error'); return; }

      list.style.display = 'none';
      actions.style.display = 'none';
      box.className = 'test-result-box testing';
      box.innerHTML = '<span class="spinner"></span> <span>正在探测模型列表...</span>';
      box.style.display = 'flex';
      btn.disabled = true;

      try {
        const res = await fetch('/api/models/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiUrl, apiKey, provider, allowUnauthorized }),
        });
        const result = await res.json();

        if (result.success && result.models && result.models.length > 0) {
          state.lastDiscovered = result.models;
          renderDiscoveredModels(result.models);
          const existsCount = result.models.filter(m => m.exists).length;
          list.style.display = 'block';
          actions.style.display = 'flex';
          box.style.display = 'none';
          showToast('成功获取 ' + result.models.length + ' 个模型' + (existsCount ? ('，其中 ' + existsCount + ' 个已本地添加') : '') + '，请勾选要添加的模型', 'success');
        } else {
          state.lastDiscovered = [];
          list.innerHTML = '';
          box.className = 'test-result-box error';
          box.innerHTML = '<div class="test-header"><span>🔴 ' + escapeHtml(result.error || '获取失败') + '</span></div>' +
            '<div class="test-detail">' + escapeHtml(result.suggestion || result.details || '') + '</div>';
          box.style.display = 'flex';
        }
      } catch (err) {
        box.className = 'test-result-box error';
        box.innerHTML = '<div class="test-header"><span>🔴 网络错误</span></div><div class="test-detail">' + escapeHtml(err.message) + '</div>';
        box.style.display = 'flex';
      } finally {
        btn.disabled = false;
      }
    }

    function renderDiscoveredModels(models) {
      const list = document.getElementById('discovered-model-list');
      list.innerHTML = '';
      models.forEach(function (m) {
        const row = document.createElement('div');
        row.className = 'discovered-item' + (m.exists ? ' exists' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'discovered-check';
        cb.value = m.id;
        cb.disabled = !!m.exists;
        cb.dataset.displayName = m.displayName || '';
        cb.onchange = updateBatchButton;
        row.appendChild(cb);

        const label = document.createElement('span');
        label.className = 'discovered-label';
        label.textContent = (m.displayName || m.id) + ' (' + m.id + ')';
        label.title = m.id;
        row.appendChild(label);

        if (m.exists) {
          const badge = document.createElement('span');
          badge.className = 'discovered-badge';
          badge.textContent = '已添加';
          row.appendChild(badge);
        } else {
          const applyBtn = document.createElement('button');
          applyBtn.type = 'button';
          applyBtn.className = 'discovered-apply';
          applyBtn.textContent = '应用到表单';
          applyBtn.onclick = function () { applyDiscoveredModel(m.id, m.displayName || m.id); };
          row.appendChild(applyBtn);
        }

        list.appendChild(row);
      });
      updateBatchButton();
    }

    function updateBatchButton() {
      const checks = document.querySelectorAll('#discovered-model-list .discovered-check:not(:disabled)');
      let count = 0;
      checks.forEach(function (c) { if (c.checked) count++; });
      document.getElementById('btn-batch-add').textContent = '批量添加所选 (' + count + ')';
    }

    function selectAllDiscovered() {
      document.querySelectorAll('#discovered-model-list .discovered-check:not(:disabled)').forEach(function (c) { c.checked = true; });
      updateBatchButton();
      showToast('已全选未添加的模型', 'success');
    }

    function clearDiscoveredSelection() {
      document.querySelectorAll('#discovered-model-list .discovered-check').forEach(function (c) { c.checked = false; });
      updateBatchButton();
    }

    function slugifyDiscovered(id) {
      return (id || 'custom-model')
        .replace(/^models\\//, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'custom-model';
    }

    async function batchAddDiscovered() {
      const selected = [];
      document.querySelectorAll('#discovered-model-list .discovered-check:checked').forEach(function (c) {
        selected.push({ id: c.value, displayName: c.dataset.displayName || c.value });
      });
      if (selected.length === 0) {
        showToast('请先勾选要批量添加的模型', 'error');
        return;
      }

      const provider = document.getElementById('form-provider').value;
      const apiUrl = document.getElementById('form-api-url').value.trim();
      const apiKey = document.getElementById('form-api-key').value.trim();
      const allowUnauthorized = document.getElementById('form-allow-unauthorized').checked;
      const timeout = parseInt(document.getElementById('form-timeout').value, 10) || undefined;
      const maxRetries = document.getElementById('form-max-retries').value !== '' ? parseInt(document.getElementById('form-max-retries').value, 10) : undefined;

      const models = selected.map(function (m) {
        return {
          externalModelName: m.id,
          displayName: m.displayName || m.id,
          name: 'models/' + slugifyDiscovered(m.id),
          provider: provider,
          apiUrl: apiUrl,
          apiKey: apiKey,
          allowUnauthorized: allowUnauthorized,
          timeout: timeout,
          maxRetries: maxRetries,
        };
      });

      const btn = document.getElementById('btn-batch-add');
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '正在添加...';

      try {
        const res = await fetch('/api/models/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ models: models }),
        });
        const json = await res.json();
        if (res.ok && json.success) {
          showToast('成功添加 ' + json.addedCount + ' 个模型' + (json.skippedCount ? '，跳过 ' + json.skippedCount + ' 个已存在的' : '') + '！', 'success');
          document.getElementById('discovered-model-list').innerHTML = '';
          document.getElementById('discovered-model-list').style.display = 'none';
          document.getElementById('discovered-model-actions').style.display = 'none';
          state.lastDiscovered = [];
          closeAddModal();
          await fetchModels();
        } else {
          showToast('批量添加失败: ' + (json.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('批量添加请求失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    }

    function applyDiscoveredModel(id, displayName) {
      if (!id) return;
      document.getElementById('form-external-name').value = id;
      const disp = document.getElementById('form-display-name');
      if (!disp.value) {
        // NOTE: this inline <script> is a JS template literal, so every regex
        // backslash must be doubled (\\) — otherwise the template literal turns
        // /\b\w/ into a backspace + "w" and /^models\// into /^models//, which
        // is invalid JS that kills the whole dashboard script.
        disp.value = id.replace(/^models\\//, '').replace(/[-_]+/g, ' ').replace(/\\b\\w/g, function (c) { return c.toUpperCase(); });
      }
      if (displayName) disp.value = displayName;
      // Auto-fill the internal model identifier (Name) from the discovered id.
      const nameInput = document.getElementById('form-name');
      if (!nameInput.value || nameInput.value.startsWith('models/')) {
        nameInput.value = 'models/' + slugifyDiscovered(id);
      }
      showToast('已自动填充外部模型名称、内部标识 (Name) 与显示名称', 'success');
    }

    function handleProviderChange() {
      const p = document.getElementById('form-provider').value;
      const urlInput = document.getElementById('form-api-url');
      if (!urlInput.value || urlInput.value.includes('localhost') || urlInput.value.includes('googleapis') || urlInput.value.includes('anthropic')) {
        if (p === 'anthropic') urlInput.value = 'https://api.anthropic.com/v1/messages';
        else if (p === 'ollama') urlInput.value = 'http://localhost:11434/v1/chat/completions';
        else if (p === 'google') urlInput.value = 'https://generativelanguage.googleapis.com/v1beta';
      }
    }

    function toggleAccordion(id) {
      const el = document.getElementById(id);
      el.classList.toggle('open');
      document.getElementById('adv-arrow').textContent = el.classList.contains('open') ? '▲' : '▼';
    }

    function togglePasswordVisibility(id) {
      const el = document.getElementById(id);
      el.type = el.type === 'password' ? 'text' : 'password';
    }

    // ─── Test Within Modal ───────────────────────────────────
    async function testCurrentForm() {
      const box = document.getElementById('form-test-result');
      const btn = document.getElementById('btn-modal-test');

      const params = {
        name: document.getElementById('form-name').value.trim(),
        displayName: document.getElementById('form-display-name').value.trim(),
        provider: document.getElementById('form-provider').value,
        apiUrl: document.getElementById('form-api-url').value.trim(),
        apiKey: document.getElementById('form-api-key').value.trim(),
        externalModelName: document.getElementById('form-external-name').value.trim(),
        allowUnauthorized: document.getElementById('form-allow-unauthorized').checked,
        timeout: parseInt(document.getElementById('form-timeout').value, 10) || 15000,
      };

      if (!params.apiUrl) {
        showToast('请先填写完整 API URL', 'error');
        return;
      }

      box.className = 'test-result-box testing';
      box.innerHTML = '<span class="spinner"></span> <span>正在测试当前表单配置连通性...</span>';
      box.style.display = 'flex';
      btn.disabled = true;

      try {
        const res = await fetch('/api/models/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params)
        });
        const result = await res.json();

        if (result.success) {
          box.className = 'test-result-box success';
          box.innerHTML = \`
            <div class="test-header">
              <span>🟢 连通性测试通过 (HTTP \${result.statusCode || 200})</span>
              <span style="font-family: var(--font-mono)">\${result.latencyMs} ms</span>
            </div>
            <div class="test-detail">响应样例: \${escapeHtml(result.reply || 'OK')}</div>
          \`;
        } else {
          box.className = 'test-result-box error';
          box.innerHTML = \`
            <div class="test-header">
              <span>🔴 \${escapeHtml(result.error || '测试失败')}</span>
              <span style="font-family: var(--font-mono)">\${result.latencyMs} ms</span>
            </div>
            <div class="test-detail">\${escapeHtml(result.suggestion || result.details || '')}</div>
          \`;
        }
      } catch (err) {
        box.className = 'test-result-box error';
        box.innerHTML = \`
          <div class="test-header"><span>🔴 网络错误</span></div>
          <div class="test-detail">\${escapeHtml(err.message)}</div>
        \`;
      } finally {
        btn.disabled = false;
      }
    }

    // ─── Submit Form ─────────────────────────────────────────
    async function submitModelForm() {
      const btn = document.getElementById('btn-modal-save');
      let name = document.getElementById('form-name').value.trim();
      if (name && !name.startsWith('models/') && !name.includes('/')) {
        name = 'models/' + name;
      }

      const model = {
        name,
        displayName: document.getElementById('form-display-name').value.trim(),
        externalModelName: document.getElementById('form-external-name').value.trim(),
        provider: document.getElementById('form-provider').value,
        apiUrl: document.getElementById('form-api-url').value.trim(),
        apiKey: document.getElementById('form-api-key').value.trim(),
        allowUnauthorized: document.getElementById('form-allow-unauthorized').checked,
        timeout: parseInt(document.getElementById('form-timeout').value, 10) || undefined,
        maxRetries: document.getElementById('form-max-retries').value !== '' ? parseInt(document.getElementById('form-max-retries').value, 10) : undefined,
      };

      if (!model.displayName || !model.name || !model.apiUrl) {
        showToast('请完整填写显示名称、内部标识与 API URL', 'error');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 正在保存...';

      try {
        const res = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(model)
        });
        const json = await res.json();

        if (res.ok && json.success) {
          showToast('模型配置已成功保存并热重载！', 'success');
          closeAddModal();
          await fetchModels();
        } else {
          showToast('保存失败: ' + (json.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('请求失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '保存模型';
      }
    }

    // ─── Delete Model ────────────────────────────────────────
    async function deleteModel(modelName) {
      if (!confirm(\`确定要删除模型 "\${modelName}" 吗？\`)) return;

      try {
        const res = await fetch('/api/models', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName })
        });
        const json = await res.json();

        if (res.ok && json.success) {
          showToast('模型已成功删除！', 'success');
          await fetchModels();
        } else {
          showToast('删除失败: ' + (json.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('网络请求失败: ' + e.message, 'error');
      }
    }

    // ─── Preset Templates ────────────────────────────────────
    function applyPreset(type) {
      openAddModal();
      const presets = {
        'deepseek': {
          displayName: 'DeepSeek-V3 (官方 API)',
          name: 'models/deepseek-v3',
          externalModelName: 'deepseek-chat',
          provider: 'openai',
          apiUrl: 'https://api.deepseek.com/v1/chat/completions',
        },
        'deepseek-r1': {
          displayName: 'DeepSeek-R1 (深度思考)',
          name: 'models/deepseek-r1',
          externalModelName: 'deepseek-reasoner',
          provider: 'openai',
          apiUrl: 'https://api.deepseek.com/v1/chat/completions',
        },
        'openai-gpt4o': {
          displayName: 'GPT-4o (OpenAI 官方)',
          name: 'models/gpt-4o',
          externalModelName: 'gpt-4o',
          provider: 'openai',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
        },
        'anthropic-claude': {
          displayName: 'Claude 3.5 Sonnet (Anthropic)',
          name: 'models/claude-3-5-sonnet',
          externalModelName: 'claude-3-5-sonnet-20241022',
          provider: 'anthropic',
          apiUrl: 'https://api.anthropic.com/v1/messages',
        },
        'ollama-local': {
          displayName: 'Llama 3 (本地 Ollama)',
          name: 'models/llama3',
          externalModelName: 'llama3',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
        },
        'openrouter': {
          displayName: 'Claude 3.5 via OpenRouter',
          name: 'models/openrouter-claude',
          externalModelName: 'anthropic/claude-3.5-sonnet',
          provider: 'openai',
          apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
        },
        'siliconflow': {
          displayName: 'DeepSeek-V3 (硅基流动)',
          name: 'models/sf-deepseek-v3',
          externalModelName: 'deepseek-ai/DeepSeek-V3',
          provider: 'openai',
          apiUrl: 'https://api.siliconflow.cn/v1/chat/completions',
        },
        'sensenova': {
          displayName: 'SenseChat-5 (商汤日日新)',
          name: 'models/sensenova-5',
          externalModelName: 'SenseChat-5',
          provider: 'openai',
          apiUrl: 'https://api.sensenova.cn/v1/llm/chat-completions',
        },
        'moonshot': {
          displayName: 'Kimi (月之暗面)',
          name: 'models/kimi-32k',
          externalModelName: 'moonshot-v1-32k',
          provider: 'openai',
          apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
        },
        'google-ai': {
          displayName: 'Gemini 2.0 Flash (AI Studio)',
          name: 'models/gemini-2-flash',
          externalModelName: 'gemini-2.0-flash',
          provider: 'google',
          apiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }
      };

      const p = presets[type];
      if (p) {
        document.getElementById('form-display-name').value = p.displayName;
        document.getElementById('form-name').value = p.name;
        document.getElementById('form-external-name').value = p.externalModelName;
        document.getElementById('form-provider').value = p.provider;
        document.getElementById('form-api-url').value = p.apiUrl;
      }
    }

    // ─── Raw JSON Modal ──────────────────────────────────────
    async function openRawModal() {
      try {
        const res = await fetch('/api/models/raw');
        const text = await res.text();
        document.getElementById('raw-json-textarea').value = text;
        document.getElementById('modal-raw-json').classList.add('open');
      } catch (e) {
        showToast('读取 Raw JSON 失败: ' + e.message, 'error');
      }
    }

    function closeRawModal() {
      document.getElementById('modal-raw-json').classList.remove('open');
    }

    function formatRawJson() {
      const textarea = document.getElementById('raw-json-textarea');
      try {
        const obj = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(obj, null, 2);
        showToast('JSON 格式化成功', 'success');
      } catch (e) {
        showToast('JSON 格式不合法: ' + e.message, 'error');
      }
    }

    async function saveRawJson() {
      const btn = document.getElementById('btn-save-raw');
      const textarea = document.getElementById('raw-json-textarea');
      btn.disabled = true;

      try {
        const res = await fetch('/api/models/raw', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: textarea.value
        });
        const json = await res.json();

        if (res.ok && json.success) {
          showToast(\`成功更新 \${json.count} 个模型配置！\`, 'success');
          closeRawModal();
          await fetchModels();
        } else {
          showToast('保存失败: ' + (json.error || '未知错误'), 'error');
        }
      } catch (e) {
        showToast('请求失败: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    }

    // ─── Help Modal ──────────────────────────────────────────
    function openHelpModal() {
      document.getElementById('modal-help').classList.add('open');
    }

    function closeHelpModal() {
      document.getElementById('modal-help').classList.remove('open');
    }

    // ─── Toast System ────────────────────────────────────────
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;

      let icon = 'ℹ️';
      if (type === 'success') icon = '✅';
      else if (type === 'error') icon = '❌';

      toast.innerHTML = \`<span>\${icon}</span> <span>\${escapeHtml(message)}</span>\`;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>
`;
}
