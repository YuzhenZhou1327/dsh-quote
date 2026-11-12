/**
 * Selection quote — highlight text anywhere in the Harness UI (conversation
 * messages or a file preview) and quote it into the composer, with the source
 * file path when there is one. Spreadsheet previews expose their cell range
 * through the renderer's own copy path, so a dragged range can be quoted as a
 * Markdown table.
 */
window.__ModuleLoader__.load({
  id: '@local/selection-quote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Materialization marker, useful when checking the live module table. */
    window.__SELECTION_QUOTE__ = { loadedAt: Date.now() };

    /**
     * Insert this plugin's stylesheet. A `<style>` element created while the
     * Client half applies is claimed by the module system and removed with it.
     * @param css - Stylesheet text.
     * @returns Disposer removing the element.
     */
    function insertStyles(css) {
      const element = document.createElement('style');
      element.textContent = css;
      document.head.appendChild(element);
      return () => element.remove();
    }

    /** Locale namespace owned by this plugin. */
    const NS = 'selection-quote';
    /** Longest quoted body kept verbatim; longer selections are truncated. */
    const MAX_CHARS = 6000;
    /** Popup chrome marker: pointer events inside it never dismiss the popup. */
    const UI_ATTR = 'data-selection-quote-ui';
    /** Flow kinds that render a human's own message rather than a reply. */
    const USER_FLOW_KINDS = new Set(['user', 'steering', 'developer-message', 'turn-trigger']);
    /**
     * Whether the Chat view materialised our text-interaction surface, i.e. this
     * Harness owns transcript gestures itself. Until it does (older Harnesses),
     * the floating toolbar keeps handling chat selections.
     */
    let chatSurfaceServed = false;

    //#region dictionaries
    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'action.quote': '引用',
      'action.quoteFile': '引用',
      'action.quoteCells': '引用单元格',
      'action.quoteClipboard': '剪贴板',
      'source.user': '用户消息',
      'source.assistant': '助手回复',
      'source.withIndex': '{role} · 第 {n} 轮',
      'source.preview': '文件预览',
      'source.previewNamed': '文件 · {name}',
      'source.sheet': '表格 · {name}',
      'source.clipboard': '剪贴板',
      'source.generic': '选中内容',
      'count.chars': '{n} 字符',
      'count.cells': '{rows} 行 × {cols} 列',
      'count.cellsRef': '{ref} · {rows} 行 × {cols} 列',
      'quote.header': '引用 · {label}',
      'quote.path': '来源',
      'quote.sheet': '工作表',
      'quote.range': '区域',
      'hint.quoteSelection': '引用选中内容',
      'hint.quoteFile': '没有选中内容：引用整个文件路径',
      'hint.cells': '引用选中的单元格',
      'hint.clipboard': '引用当前剪贴板里的文字（隔离预览中的文字请先 Ctrl+C）',
      'error.emptyClipboard': '剪贴板里没有可引用的文本',
      'error.noComposer': '找不到可以写入的输入框',
      'error.insert': '草稿刚刚发生变化，请重试',
      'title.quote': '插入引用，并把光标留在引用下方以便继续追问（快捷键 Ctrl+Shift+Q）',
    };
    /** English dictionary with the same key set. */
    const en = {
      'action.quote': 'Quote',
      'action.quoteFile': 'Quote',
      'action.quoteCells': 'Quote cells',
      'action.quoteClipboard': 'Clipboard',
      'source.user': 'User message',
      'source.assistant': 'Assistant reply',
      'source.withIndex': '{role} · turn {n}',
      'source.preview': 'File preview',
      'source.previewNamed': 'File · {name}',
      'source.sheet': 'Sheet · {name}',
      'source.clipboard': 'Clipboard',
      'source.generic': 'Selection',
      'count.chars': '{n} chars',
      'count.cells': '{rows} rows × {cols} cols',
      'count.cellsRef': '{ref} · {rows} rows × {cols} cols',
      'quote.header': 'Quote · {label}',
      'quote.path': 'Source',
      'quote.sheet': 'Sheet',
      'quote.range': 'Range',
      'hint.quoteSelection': 'Quote the selected text',
      'hint.quoteFile': 'No selection: quote the whole file path',
      'hint.cells': 'Quote the selected cells',
      'hint.clipboard': 'Quote the clipboard text (copy from an isolated preview first)',
      'error.emptyClipboard': 'The clipboard holds no quotable text',
      'error.noComposer': 'No composer available for insertion',
      'error.insert': 'The draft just changed; please retry',
      'title.quote': 'Insert the quote and leave the caret below it for your follow-up (Ctrl+Shift+Q)',
    };
    //#endregion

    /** Translate thunk bound to the live Client locale. */
    let boundT = (key) => key;

    //#region store
    /** Bridge facades published by the mounted composer dock, keyed by session. */
    const bridges = new Map();
    /** Shared, observable UI state (not React state: written from DOM listeners). */
    const state = {
      pop: null,
      notice: null,
      preview: null,
      lastBridge: null,
    };
    /** Live subscribers; each emit re-renders the overlay. */
    const listeners = new Set();
    /** Pending notice timer, cleared on every new notice. */
    let noticeTimer = 0;

    function emit() {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          console.error('[selection-quote] listener failed', error);
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    /** React binding: re-render on every store emit. */
    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => subscribe(() => force((value) => value + 1)), []);
      return state;
    }

    function notify(text) {
      state.notice = { text };
      if (noticeTimer !== 0) window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => {
        noticeTimer = 0;
        state.notice = null;
        emit();
      }, 2600);
      emit();
    }

    function dismiss() {
      if (state.pop === null) return;
      state.pop = null;
      emit();
    }

    /** The composer facade a quote should be written through. */
    function pickBridge(preferredSessionId) {
      if (preferredSessionId !== undefined && bridges.has(preferredSessionId)) return bridges.get(preferredSessionId);
      if (state.preview !== null && state.preview.sessionId !== undefined && bridges.has(state.preview.sessionId)) {
        return bridges.get(state.preview.sessionId);
      }
      if (state.lastBridge !== null && bridges.get(state.lastBridge.sessionId) !== undefined) return state.lastBridge;
      if (bridges.size === 1) return bridges.values().next().value;
      return null;
    }
    //#endregion

    //#region selection capture
    function elementOf(node) {
      if (node === null || node === undefined) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement ?? null;
    }

    function clamp(value, minimum, maximum) {
      if (maximum < minimum) return minimum;
      return Math.min(Math.max(value, minimum), maximum);
    }

    function baseName(path) {
      const text = String(path);
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
      return index < 0 ? text : text.slice(index + 1);
    }

    function isSpreadsheet(path) {
      return /\.(xlsx|xlsm|xlsb|xls|csv|tsv|ods)$/i.test(String(path ?? ''));
    }

    /**
     * Which sheet and which cells the spreadsheet preview currently has
     * selected. The grid is a canvas, so the renderer's own chrome is the only
     * place these two facts are written down: the sheet tabs mark the active
     * sheet, and the name box prints the selected range in A1 notation (the
     * top-left corner before the colon, the bottom-right corner after it).
     * @returns { sheetName: string, range: string } — empty strings when unknown.
     */
    function sheetLocation() {
      const preview = document.querySelector('[data-excel-preview]');
      if (preview === null) return { sheetName: '', range: '' };
      const box = preview.querySelector('.fortune-name-box');
      const range = box === null ? '' : String(box.textContent ?? '').trim();
      const name = preview.querySelector('.luckysheet-sheets-item-active .luckysheet-sheets-item-name');
      const sheetName = name === null ? '' : String(name.textContent ?? '').trim();
      return { sheetName, range: normalizeRange(range) };
    }

    /** `$A$1:$C$3` and `a1:c3` are the same range, printed as `A1:C3`. */
    function normalizeRange(text) {
      const cleaned = String(text ?? '').replace(/[$\s]/g, '').toUpperCase();
      if (cleaned === '') return '';
      const parts = cleaned.split(':');
      if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
      return cleaned;
    }

    /**
     * Describe where a selection lives so the quote can name its origin.
     * @param element - element containing the selection anchor.
     * @returns origin descriptor.
     */
    function describeSource(element) {
      const panel = element.closest('[data-sidebar-right-panel]');
      if (panel !== null) {
        const preview = state.preview;
        return {
          kind: 'preview',
          name: preview?.name ?? null,
          absolutePath: preview?.absolutePath ?? null,
          sessionId: preview?.sessionId,
          label: preview?.name === null || preview?.name === undefined
            ? boundT('source.preview')
            : boundT('source.previewNamed', { name: preview.name }),
        };
      }
      const flow = element.closest('[data-chat-flow-kind]');
      const flowKind = flow?.getAttribute('data-chat-flow-kind') ?? null;
      if (flow !== null || element.closest('[data-conversation-scroll]') !== null) {
        // Only the message kinds carry a human's own words; every other flow
        // row (assistant-step, tool-call, turn-process, …) is the reply side.
        const role = flowKind === null ? null : USER_FLOW_KINDS.has(flowKind) ? 'user' : 'assistant';
        const turnElement = element.closest('[data-chat-turn]');
        const turnNumber = turnElement === null ? NaN : Number(turnElement.getAttribute('data-chat-turn'));
        const index = Number.isSafeInteger(turnNumber) ? turnNumber : null;
        const roleLabel = role === 'assistant' ? boundT('source.assistant') : role === 'user' ? boundT('source.user') : boundT('source.generic');
        return {
          kind: 'chat',
          role,
          index,
          label: index === null ? roleLabel : boundT('source.withIndex', { role: roleLabel, n: index }),
        };
      }
      return { kind: 'other', label: boundT('source.generic') };
    }

    /** Text of the current DOM selection, or an empty string. */
    function selectionText() {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return '';
      return String(selection.toString() ?? '').trim();
    }

    function selectionTextWithin(selector) {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return '';
      const element = elementOf(selection.anchorNode);
      if (element === null || element.closest(selector) === null) return '';
      return String(selection.toString() ?? '').trim();
    }

    /**
     * Read the live selection and publish the floating toolbar when it qualifies.
     * @param allowChat - also react to transcript selections. On Harnesses that
     * ship the Chat text-interaction slot, the Chat view owns those gestures and
     * renders our action surface (ChatQuoteAction), so the pointer path leaves
     * them alone and only the keyboard shortcut opts in; on older Harnesses the
     * slot never materialises and this floating toolbar keeps covering chat.
     */
    function readSelectionPop(allowChat = false) {
      if (state.pop !== null && state.pop.kind !== 'text') return;
      const selection = window.getSelection();
      const text = selectionText();
      if (text === '') {
        if (state.pop !== null && state.pop.kind === 'text') dismiss();
        return;
      }
      const element = elementOf(selection.anchorNode);
      if (element === null) return;
      if (element.closest(`[${UI_ATTR}]`) !== null) return;
      // The composer's own draft is editable text, never a quote source.
      if (element.closest('[data-composer-seat]') !== null) return;
      if (element.closest('textarea, input, [contenteditable="true"]') !== null) return;
      if (!allowChat && chatSurfaceServed && element.closest('[data-conversation-scroll]') !== null) {
        if (state.pop !== null && state.pop.kind === 'text') dismiss();
        return;
      }
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (rect === undefined || (rect.width === 0 && rect.height === 0)) return;
      state.pop = {
        kind: 'text',
        text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text,
        fullLength: text.length,
        source: describeSource(element),
        anchor: { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom },
        error: null,
      };
      emit();
    }

    /** Publish a clipboard-derived popup for text or spreadsheet cells. */
    function showClipboardPop(anchorElement, text, kind) {
      const trimmed = String(text ?? '');
      if (trimmed.trim() === '') return;
      const element = anchorElement instanceof Element ? anchorElement : null;
      const panel = element?.closest('[data-sidebar-right-panel]') ?? null;
      const rect = panel?.getBoundingClientRect() ?? null;
      const preview = state.preview;
      const cells = kind === 'cells';
      state.pop = {
        kind: cells ? 'cells' : 'clipboard',
        text: trimmed.length > MAX_CHARS ? trimmed.slice(0, MAX_CHARS) : trimmed,
        fullLength: trimmed.length,
        cellRef: cells ? sheetLocation() : null,
        source: {
          kind: cells ? 'sheet' : 'preview',
          name: preview?.name ?? null,
          absolutePath: preview?.absolutePath ?? null,
          sessionId: preview?.sessionId,
          label: cells
            ? boundT('source.sheet', { name: preview?.name ?? '—' })
            : preview?.name === null || preview?.name === undefined
              ? boundT('source.clipboard')
              : boundT('source.previewNamed', { name: preview.name }),
        },
        anchor: rect === null
          ? { left: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2 }
          : { left: rect.left + rect.width / 2, top: rect.top + 24, bottom: rect.top + 40 },
        error: null,
      };
      emit();
    }
    //#endregion

    //#region DOM listeners
    /**
     * Install the document-level selection and copy listeners.
     * @returns disposer removing every listener.
     */
    function installDomListeners() {
      /** Pointer origin inside a spreadsheet preview, for drag detection. */
      let sheetGrab = null;
      const onPointerDown = (event) => {
        const element = elementOf(event.target);
        if (element !== null && element.closest(`[${UI_ATTR}]`) !== null) return;
        const sheet = element === null ? null : element.closest('[data-excel-preview]');
        sheetGrab = sheet === null ? null : { sheet, x: event.clientX, y: event.clientY };
        dismiss();
      };
      const onPointerUp = (event) => {
        const element = elementOf(event.target);
        if (element !== null && element.closest(`[${UI_ATTR}]`) !== null) return;
        const grab = sheetGrab;
        sheetGrab = null;
        if (grab !== null) {
          // A dragged cell range is only readable through the renderer's own
          // copy path, so ask for it as soon as the drag ends.
          const moved = Math.abs(event.clientX - grab.x) > 6 || Math.abs(event.clientY - grab.y) > 6;
          if (moved) window.setTimeout(() => requestSheetCopy(grab.sheet), 40);
        }
        window.setTimeout(readSelectionPop, 0);
      };
      const onKeyUp = (event) => {
        if (event.key === 'Escape') {
          dismiss();
          return;
        }
        if (event.shiftKey || event.ctrlKey || event.metaKey) window.setTimeout(readSelectionPop, 0);
      };
      /** Keyboard path for people who never reach for the mouse. */
      const onKeyDown = (event) => {
        if (event.altKey || !(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
        if (String(event.key).toLowerCase() !== 'q') return;
        const element = elementOf(event.target);
        if (element !== null && element.closest(`[${UI_ATTR}]`) !== null) return;
        event.preventDefault();
        event.stopPropagation();
        readSelectionPop(true);
        applyPop();
      };
      const onScroll = (event) => {
        const element = elementOf(event.target);
        if (element !== null && element.closest(`[${UI_ATTR}]`) !== null) return;
        dismiss();
      };
      /**
       * Spreadsheet ranges and isolated previews only leave through the copy
       * path: use the DataTransfer when the source wrote into this document,
       * otherwise fall back to the renderer's mirror and the clipboard.
       */
      const onCopy = (event) => {
        const element = elementOf(event.target);
        if (element === null) return;
        if (element.closest('[data-sidebar-right-panel]') === null) return;
        const cells = element.closest('[data-excel-preview]') !== null;
        let text = '';
        try {
          text = String(event.clipboardData?.getData('text/plain') ?? '');
        } catch {
          text = '';
        }
        if (text.trim() !== '') {
          showClipboardPop(element, text, cells ? 'cells' : 'doc');
          return;
        }
        window.setTimeout(async () => {
          const mirrored = readSessionClipboard();
          if (mirrored.trim() !== '') {
            showClipboardPop(element, mirrored, cells ? 'cells' : 'doc');
            return;
          }
          const clipboard = await readClipboardText();
          if (clipboard !== '') showClipboardPop(element, clipboard, cells ? 'cells' : 'doc');
        }, 90);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('pointerup', onPointerUp, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('scroll', onScroll, true);
      document.addEventListener('copy', onCopy, false);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('pointerup', onPointerUp, true);
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('keyup', onKeyUp, true);
        document.removeEventListener('scroll', onScroll, true);
        document.removeEventListener('copy', onCopy, false);
        state.pop = null;
      };
    }
    //#endregion

    //#region quoting
    async function readClipboardText() {
      try {
        const clipboard = navigator.clipboard;
        if (clipboard === undefined || typeof clipboard.readText !== 'function') return '';
        const text = await clipboard.readText();
        return typeof text === 'string' ? text : '';
      } catch {
        return '';
      }
    }

    /** Text the spreadsheet renderer mirrors into session storage on copy. */
    function readSessionClipboard() {
      try {
        const text = window.sessionStorage.getItem('localClipboard');
        return typeof text === 'string' ? text : '';
      } catch {
        return '';
      }
    }

    /**
     * Ask the spreadsheet renderer to copy its current range: the selection
     * lives in its canvas, so its own copy path is the only way out.
     * @param sheet - element inside the spreadsheet preview.
     */
    function requestSheetCopy(sheet) {
      const preview = sheet?.closest('[data-excel-preview]');
      if (preview === null || preview === undefined) return;
      const before = readSessionClipboard();
      const target = preview.querySelector('canvas') ?? preview;
      const ask = () => {
        try {
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'c',
            code: 'KeyC',
            keyCode: 67,
            which: 67,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }));
          return true;
        } catch (error) {
          console.error('[selection-quote] spreadsheet copy failed', error);
          return false;
        }
      };
      /** @returns true when a range became available. */
      const settle = () => {
        if (state.pop !== null && state.pop.kind === 'cells') return true;
        const after = readSessionClipboard();
        if (after.trim() === '' || after === before) return false;
        showClipboardPop(preview, after, 'cells');
        return true;
      };
      ask();
      // The renderer may need a beat to finish its own selection, so retry once.
      window.setTimeout(() => {
        if (settle()) return;
        if (!ask()) return;
        window.setTimeout(settle, 260);
      }, 260);
    }

    function toBlockquote(text) {
      const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
      return lines.map((line) => (line.length === 0 ? '>' : `> ${line.replace(/[ \t]+$/, '')}`)).join('\n');
    }

    /**
     * Render tab-separated clipboard data as pipe-separated rows. No Markdown
     * header delimiter: a selected block has no header row unless the sheet
     * happens to start with one, and the separator would read as fake data.
     */
    function tsvToTable(text) {
      const rows = String(text)
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/, '')
        .split('\n')
        .map((row) => row.split('\t'));
      const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 1);
      const normalize = (row) => {
        const cells = row.slice();
        while (cells.length < width) cells.push('');
        return cells.map((cell) => String(cell).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' '));
      };
      return rows.map((row) => `| ${normalize(row).join(' | ')} |`).join('\n');
    }

    function cellShape(text) {
      const rows = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
      const columns = rows.reduce((maximum, row) => Math.max(maximum, row.split('\t').length), 0);
      return { rows: rows.length, columns };
    }

    /** A1-notation reference for a cell selection, e.g. `Sheet1!A1:C3`. */
    function cellReference(cellRef) {
      if (cellRef === null || cellRef === undefined) return '';
      const sheet = typeof cellRef.sheetName === 'string' ? cellRef.sheetName : '';
      const range = typeof cellRef.range === 'string' ? cellRef.range : '';
      if (sheet !== '' && range !== '') return `${sheet}!${range}`;
      return sheet !== '' ? sheet : range;
    }

    /** Header line plus the source file path, when the quote has one. */
    function quoteHeader(label, absolutePath, extraLines) {
      const lines = [`> ${boundT('quote.header', { label })}`];
      if (Array.isArray(extraLines)) {
        for (const line of extraLines) if (line !== '') lines.push(`> ${line}`);
      }
      if (typeof absolutePath === 'string' && absolutePath !== '') {
        lines.push(`> ${boundT('quote.path')}：${absolutePath}`);
      }
      return lines.join('\n');
    }

    /**
     * Sheet and range lines for a cell quote: the model cannot see the grid, so
     * it needs to be told which sheet and which cell block was quoted.
     * @param cellRef - result of {@link sheetLocation}, or null.
     * @returns header lines, empty when the location is unknown.
     */
    function cellLocationLines(cellRef) {
      if (cellRef === null || cellRef === undefined) return [];
      const lines = [];
      if (typeof cellRef.sheetName === 'string' && cellRef.sheetName !== '') {
        lines.push(`${boundT('quote.sheet')}：${cellRef.sheetName}`);
      }
      if (typeof cellRef.range === 'string' && cellRef.range !== '') {
        lines.push(`${boundT('quote.range')}：${cellRef.range}`);
      }
      return lines;
    }

    /**
     * Freshest sheet/range for a cell popup: the renderer updates its name box
     * a moment after the drag ends, so re-read it at quote time when possible.
     * @param pop - popup payload.
     * @returns cell location, or null for non-cell payloads.
     */
    function liveCellRef(pop) {
      if (pop.kind !== 'cells') return null;
      const live = sheetLocation();
      if (live.range !== '' || live.sheetName !== '') return live;
      return pop.cellRef ?? null;
    }

    /** Full quote block for one popup payload. */
    function buildQuote(pop) {
      const body = toBlockquote(pop.kind === 'cells' ? tsvToTable(pop.text) : pop.text);
      return `${quoteHeader(pop.source.label, pop.source.absolutePath, cellLocationLines(liveCellRef(pop)))}\n${body}\n\n`;
    }

    function composerEditor() {
      const seat = document.querySelector('[data-composer-seat]');
      if (seat === null) return null;
      return seat.querySelector('[contenteditable="true"], textarea');
    }

    /** Put the caret at the end of the composer so a follow-up can be typed. */
    function focusComposer() {
      window.setTimeout(() => {
        const editor = composerEditor();
        if (editor === null) return;
        try {
          editor.focus({ preventScroll: true });
        } catch {
          editor.focus();
        }
        if (editor.isContentEditable) {
          const selection = window.getSelection();
          if (selection === null) return;
          selection.selectAllChildren(editor);
          selection.collapseToEnd();
          return;
        }
        if (typeof editor.setSelectionRange === 'function') {
          const end = editor.value.length;
          editor.setSelectionRange(end, end);
        }
      }, 30);
    }

    /**
     * Insert text into the composer through the public InputActions surface.
     * @param text - quote block to insert.
     * @param sessionId - preferred target session.
     * @returns true when the draft accepted the insertion.
     */
    function insertQuote(text, sessionId) {
      const bridge = pickBridge(sessionId);
      if (bridge === null) {
        notify(boundT('error.noComposer'));
        return false;
      }
      const draft = String(bridge.draft ?? '');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const span = bridge.inputActions.captureInsertion();
        const before = draft.slice(0, span.start);
        const lead = span.start > 0 && /\n$/.test(before) === false ? '\n\n' : '';
        if (bridge.inputActions.insertText(`${lead}${text}`, span) !== false) {
          focusComposer();
          return true;
        }
      }
      notify(boundT('error.insert'));
      return false;
    }

    /** Quote the payload behind the floating toolbar. */
    function applyPop() {
      const pop = state.pop;
      if (pop === null) return;
      if (insertQuote(buildQuote(pop), pop.source.sessionId)) dismiss();
    }

    /** Header action: quote the pane selection when present, else the whole file. */
    function quotePaneOrFile(absolutePath, sessionId) {
      const selected = selectionTextWithin('[data-sidebar-right-panel]');
      if (selected !== '') {
        const text = selected.length > MAX_CHARS ? `${selected.slice(0, MAX_CHARS)}…` : selected;
        const preview = state.preview;
        const label = preview?.name === null || preview?.name === undefined
          ? boundT('source.preview')
          : boundT('source.previewNamed', { name: preview.name });
        insertQuote(`${quoteHeader(label, absolutePath ?? preview?.absolutePath)}\n${toBlockquote(text)}\n\n`, sessionId);
        dismiss();
        return;
      }
      if (absolutePath === null) {
        notify(boundT('hint.quoteFile'));
        return;
      }
      const label = boundT('source.previewNamed', { name: baseName(absolutePath) });
      insertQuote(`${quoteHeader(label, absolutePath)}\n\n`, sessionId);
      dismiss();
    }

    /** Header action: quote whatever text is currently on the clipboard. */
    async function quoteClipboard(absolutePath, sessionId, sheet) {
      const text = await readClipboardText();
      if (text.trim() === '') {
        notify(boundT('error.emptyClipboard'));
        return;
      }
      const name = absolutePath === null ? null : baseName(absolutePath);
      const label = sheet
        ? boundT('source.sheet', { name: name ?? '—' })
        : name === null
          ? boundT('source.clipboard')
          : boundT('source.previewNamed', { name });
      const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
      const body = toBlockquote(sheet ? tsvToTable(clipped) : clipped);
      const extras = sheet ? cellLocationLines(sheetLocation()) : [];
      insertQuote(`${quoteHeader(label, absolutePath, extras)}\n${body}\n\n`, sessionId);
      dismiss();
    }
    //#endregion

    //#region components
    /** Publish the composer's InputActions so popups outside the session scope can insert. */
    function BridgeDock(props) {
      const draft = typeof props.useInput === 'function' ? props.useInput((input) => input.draft) : '';
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      React.useEffect(() => {
        if (inputActions === undefined || sessionId === undefined || sessionId === null) return;
        const previous = bridges.get(sessionId);
        const next = { sessionId, inputActions, draft: String(draft ?? '') };
        if (previous !== undefined && previous.inputActions === inputActions && previous.draft === next.draft) return;
        bridges.set(sessionId, next);
        state.lastBridge = next;
        emit();
      });
      React.useEffect(() => () => {
        if (sessionId === undefined) return;
        const current = bridges.get(sessionId);
        if (current !== undefined && current.inputActions === inputActions) {
          bridges.delete(sessionId);
          if (state.lastBridge === current) state.lastBridge = null;
          emit();
        }
      }, []);
      return null;
    }

    function PopupButton({ label, title, onPress }) {
      return h('button', {
        type: 'button',
        className: 'sq-btn',
        title,
        onMouseDown: (event) => event.preventDefault(),
        onClick: onPress,
      }, label);
    }

    /**
     * Quote button inside the Chat view's own selection surface. Registering
     * this key replaces the shipped "引用文本" action: the Chat view still owns
     * admission, positioning, dismissal, and selection clearing, while the text
     * inserted here is this plugin's quote block (source label, file path, sheet
     * range) instead of a bare blockquote of the selected text.
     */
    function ChatQuoteAction(props) {
      const t = props.t ?? boundT;
      const writable = typeof props.useSession === 'function'
        ? props.useSession((session) => !session.removed && (session.subagent === null || (session.subagent.address.mode === 'continuable' && session.subagent.parentAvailable === true)))
        : true;
      React.useEffect(() => {
        if (!writable && typeof props.dismiss === 'function') props.dismiss();
      }, [writable, props.dismiss]);
      if (!writable) return null;
      // The surface opened for a live selection, so this read is the same one
      // the click will use; the hint just mirrors the floating toolbar's.
      const length = String((typeof props.readText === 'function' ? props.readText() : null) ?? '').length;
      const onPress = () => {
        const raw = typeof props.readText === 'function' ? props.readText() : null;
        const text = String(raw ?? '');
        if (text.trim() === '') {
          if (typeof props.dismiss === 'function') props.dismiss();
          return;
        }
        const selection = window.getSelection();
        const element = selection === null || selection.rangeCount === 0 ? null : elementOf(selection.anchorNode);
        const fallback = document.querySelector('[data-conversation-scroll]') ?? document.body;
        const pop = {
          kind: 'text',
          text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text,
          fullLength: text.length,
          source: describeSource(element ?? fallback),
          cellRef: null,
        };
        // Clear the transcript selection first: `insertQuote` focuses the
        // composer and parks a caret there, and clearing ranges afterwards
        // would drop that caret again (the shipped action clears afterwards
        // only because it never moves focus).
        if (typeof props.clearSelection === 'function') props.clearSelection();
        if (!insertQuote(buildQuote(pop), props.sessionId)) return;
        if (typeof props.dismiss === 'function') props.dismiss();
      };
      return h('div', { className: 'sq-chat-pop', [UI_ATTR]: '' },
        h('button', {
          type: 'button',
          className: 'sq-btn',
          title: t('title.quote'),
          onMouseDown: (event) => event.preventDefault(),
          onPointerDown: (event) => event.preventDefault(),
          onClick: onPress,
        }, t('action.quote')),
        h('span', { className: 'sq-hint' }, t('count.chars', { n: length })),
      );
    }

    /** Floating toolbar above a qualifying selection or clipboard popup. */
    function Toolbar(props) {
      const store = useStore();
      const t = props.t ?? boundT;
      const pop = store.pop;
      const notice = store.notice;
      const nodes = [];
      if (pop !== null) {
        let hint;
        if (pop.kind === 'cells') {
          const shape = cellShape(pop.text);
          const ref = cellReference(pop.cellRef);
          hint = ref === ''
            ? t('count.cells', { rows: shape.rows, cols: shape.columns })
            : t('count.cellsRef', { ref, rows: shape.rows, cols: shape.columns });
        } else {
          hint = t('count.chars', { n: pop.fullLength ?? pop.text.length });
        }
        const buttons = pop.kind === 'cells'
          ? [h(PopupButton, { key: 'cells', label: t('action.quoteCells'), title: t('hint.cells'), onPress: applyPop })]
          : [h(PopupButton, { key: 'quote', label: t('action.quote'), title: t('title.quote'), onPress: applyPop })];
        const width = 190;
        const left = clamp(pop.anchor.left, width / 2 + 8, window.innerWidth - width / 2 - 8);
        let top = pop.anchor.bottom + 8;
        if (top + 44 > window.innerHeight) top = Math.max(8, pop.anchor.top - 44);
        nodes.push(h('div', {
          key: 'pop',
          className: 'sq-pop',
          [UI_ATTR]: '',
          style: { left: `${left}px`, top: `${top}px` },
        }, ...buttons, h('span', { className: 'sq-hint' }, hint)));
      }
      if (notice !== null) {
        nodes.push(h('div', { key: 'notice', className: 'sq-toast', [UI_ATTR]: '' }, notice.text));
      }
      if (nodes.length === 0) return null;
      return h(React.Fragment, null, ...nodes);
    }

    /** File-preview header actions: quote the pane selection / file, or the clipboard. */
    function DocumentActions(props) {
      // Re-render with the store; the pane selection itself is read on click.
      useStore();
      const t = props.t ?? boundT;
      const absolutePath = typeof props.absolutePath === 'string' && props.absolutePath !== '' ? props.absolutePath : null;
      const sessionId = props.sessionId;
      const name = absolutePath === null ? null : baseName(absolutePath);
      const sheet = isSpreadsheet(absolutePath);
      React.useEffect(() => {
        if (absolutePath === null) return undefined;
        state.preview = { absolutePath, name, sessionId };
        emit();
        return () => {
          if (state.preview !== null && state.preview.absolutePath === absolutePath) {
            state.preview = null;
            emit();
          }
        };
      }, [absolutePath, sessionId, name]);
      const hasSelection = selectionTextWithin('[data-sidebar-right-panel]') !== '';
      return h('span', { className: 'sq-actions', [UI_ATTR]: '' },
        h('button', {
          type: 'button',
          className: 'sq-action',
          title: hasSelection ? t('hint.quoteSelection') : t('hint.quoteFile'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => quotePaneOrFile(absolutePath, sessionId),
        }, t('action.quoteFile')),
        h('button', {
          type: 'button',
          className: 'sq-action',
          title: sheet ? t('hint.cells') : t('hint.clipboard'),
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            quoteClipboard(absolutePath, sessionId, sheet).catch(() => notify(t('error.emptyClipboard')));
          },
        }, sheet ? t('action.quoteCells') : t('action.quoteClipboard')),
      );
    }
    //#endregion

    //#region styles
    const CSS = `
.sq-pop,.sq-chat-pop{pointer-events:auto;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3,0 0 1px #0003,0 12px 32px #00000014);font:12px/20px var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary);white-space:nowrap}
.sq-pop{position:fixed;z-index:2147483000;transform:translateX(-50%);max-width:520px}
.sq-btn{all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;white-space:nowrap;color:var(--dsw-alias-label-primary);font:12px/20px var(--dsw-font-family,inherit)}
.sq-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sq-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.sq-hint{padding:0 6px 0 4px;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:11px/16px var(--dsw-font-family,inherit)}
.sq-toast{position:fixed;z-index:2147483000;pointer-events:none;left:50%;bottom:96px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font:12px/18px var(--dsw-font-family,inherit);max-width:420px}
.sq-actions{display:inline-flex;align-items:center;gap:2px}
.sq-action{all:unset;cursor:pointer;display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;color:var(--dsw-alias-label-secondary);font:12px/1 var(--dsw-font-family,inherit);white-space:nowrap}
.sq-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sq-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
`;
    //#endregion

    //#region plugin
    /**
     * Register the dictionaries, stylesheet, DOM listeners, and the slots.
     * @param ctx - Client plugin context.
     */
    function applyInner(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'selection-quote: dictionaries');
      boundT = ctx.locale.bind(NS);
      ctx.effect(() => insertStyles(CSS), 'selection-quote: styles');
      ctx.effect(() => installDomListeners(), 'selection-quote: selection listeners');

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'selection-quote.bridge',
        order: 4,
        locale: NS,
      }, BridgeDock));

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'selection-quote.toolbar',
        order: 20,
        locale: NS,
      }, Toolbar));

      ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.document.actions',
        id: 'selection-quote.document-actions',
        order: 5,
        locale: NS,
      }, DocumentActions));

      // Take over the Chat text-interaction surface: the owner dispatches this
      // key, and a lower priority shadows the shipped "引用文本" action. The
      // callback runs only once the slot exists, which also tells the floating
      // toolbar to leave transcript selections to this surface.
      try {
        ctx.slots.inject('conversation.chat.text-interaction', () => {
          chatSurfaceServed = true;
          return ctx.slots.register({
            name: 'conversation.chat.text-interaction',
            key: 'quote',
            priority: -1,
            locale: NS,
          }, ChatQuoteAction);
        });
      } catch (error) {
        // Harnesses without the slot keep the floating toolbar everywhere; keep
        // the reason readable instead of failing the whole apply.
        chatSurfaceServed = false;
        try {
          window.localStorage.setItem('selection-quote.error', String(error && error.message ? error.message : error));
        } catch {}
      }

      try {
        window.localStorage.setItem('selection-quote.loaded', String(Date.now()));
        window.localStorage.removeItem('selection-quote.error');
        // Older builds parked apply failures in the window title; clear the
        // leftover so the frame shows the product name again.
        if (String(document.title).startsWith('SQ-ERROR')) document.title = 'DeepSeek Harness';
      } catch {}
    }

    /**
     * Guard rail: a Client half that throws inside `apply` leaves every slot
     * empty with the reason only in the devtools console, so keep the message
     * where the next debugging round can read it.
     */
    function apply(ctx) {
      try {
        applyInner(ctx);
      } catch (error) {
        const text = String((error !== null && error !== undefined && error.stack) || error).replace(/\s+/g, ' ').slice(0, 400);
        try {
          window.localStorage.setItem('selection-quote.error', text);
        } catch {}
        throw error;
      }
    }

    return { inject: ['locale', 'slots'], apply };
    //#endregion
  },
});