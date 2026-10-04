// Client 半侧：插件页里「落盘白名单」的配置页。
//
// 挂载点：侧栏 插件 → dsh-extension-cdp → 行 id `dsh-extension-cdp` → 该行的「配置」。
// key 的规则是 <包名>#<patch 里声明的行 id>（ui-plugin-manager 的 rowConfigKey），
// 而这一行就是 @deepseek-ai/dsh-mcp-client 那一行 —— 白名单最终写在它的 env 里。
//
// 为什么不走官方的 Config 表单：dsh-settings 的表格只编辑插件 Config 里标了 .volatile()
// 的字段，dsh-mcp-client 一个都没有（见 index.js 顶部注释）。所以这里自己画表单，
// 读写都走 index.js 注册的 /api/dsh-extension-cdp/workspaces/*。
//
// 样式只用主题 token（--dsw-alias-*），不引任何 Harness Client 包：那些包会变，
// 而普通 JS 插件没有类型检查，一个抛错的组件会把整个 slot 条目标成崩溃。
window.__ModuleLoader__.load({
  id: 'dsh-extension-cdp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-extension-cdp';
    const BRIDGE = '/api/dsh-extension-cdp/workspaces';

    const I18N = {
      zh: {
        summary: '落盘白名单：在这一行的配置页里设置',
        intro:
          'chrome-devtools-mcp 1.6 起，截图 / 装扩展 / 上传文件这些会写盘的工具只能写在白名单目录里' +
          '（系统临时目录始终可用）。一行一个目录，必须是已存在的绝对路径。',
        label: '允许落盘的目录',
        placeholder: 'C:\\Users\\me\\Desktop\nD:\\shots',
        pick: '选择目录…',
        save: '保存',
        saving: '保存中…',
        reset: '清除覆盖',
        resetting: '清除中…',
        saved: '已保存，白名单立即生效（MCP 那一行会重启，当前 CDP 连接会断一下）。',
        resetDone: '已清除：这一行回到 bundle 默认值（只剩系统临时目录）。',
        emptyHint: '留空 = 不给额外目录，只有系统临时目录能写。',
        missingWarn: '这些目录已经不存在了：{dirs}（上游对每个根做 realpath，会让整次调用失败）',
        invalidTitle: '这些条目不合法，一条都没写入：',
        reasonRelative: '必须是绝对路径',
        reasonMissing: '目录不存在',
        reasonNotDir: '这是文件，不是目录',
        reasonUnreadable: '读不到（权限或路径写法有问题）',
        dirty: '有未保存的改动',
        errRowMissing: '找不到 MCP 那一行（插件被卸载或改了 id）。',
        errRowInactive: 'MCP 那一行没在运行：先到插件页把这一行打开。',
        errLoopback: '只接受本机请求。',
        errWriteFailed: '写入失败：{message}',
        errGeneric: '请求失败：{code}',
        pickHint: '选择目录需要客户端目录选择器；用不了时直接在上面手填路径。',
      },
      en: {
        summary: 'Write allowlist: configure it on this row’s configuration page',
        intro:
          'Since chrome-devtools-mcp 1.6, tools that write files (screenshots, extension install, uploads) ' +
          'may only write inside allowlisted directories (the OS temp dir always works). One directory per line, absolute and existing.',
        label: 'Directories screenshots may be written to',
        placeholder: 'C:\\Users\\me\\Desktop\nD:\\shots',
        pick: 'Choose directory…',
        save: 'Save',
        saving: 'Saving…',
        reset: 'Remove override',
        resetting: 'Removing…',
        saved: 'Saved. The allowlist is live (the MCP row restarts, so the current CDP connection drops briefly).',
        resetDone: 'Override removed: this row falls back to the bundle default (OS temp dir only).',
        emptyHint: 'Empty = no extra directory; only the OS temp dir is writable.',
        missingWarn: 'These directories are gone: {dirs} (every root is realpath’d, so a call would fail)',
        invalidTitle: 'Nothing was written — these entries are invalid:',
        reasonRelative: 'must be an absolute path',
        reasonMissing: 'directory does not exist',
        reasonNotDir: 'this is a file, not a directory',
        reasonUnreadable: 'unreadable (permissions or a malformed path)',
        dirty: 'unsaved changes',
        errRowMissing: 'The MCP row is gone (bundle uninstalled, or its id changed).',
        errRowInactive: 'The MCP row is not running: enable it on the Plugins page first.',
        errLoopback: 'Loopback requests only.',
        errWriteFailed: 'Write failed: {message}',
        errGeneric: 'Request failed: {code}',
        pickHint: 'Choosing a directory needs the client directory picker; type the path by hand when it is unavailable.',
      },
    };

    const REASON_KEY = {
      relative: 'reasonRelative',
      missing: 'reasonMissing',
      'not-a-directory': 'reasonNotDir',
      unreadable: 'reasonUnreadable',
    };
    const CODE_KEY = {
      'row-missing': 'errRowMissing',
      'row-inactive': 'errRowInactive',
      'loopback-only': 'errLoopback',
      'write-failed': 'errWriteFailed',
    };

    async function post(action, body) {
      let response;
      try {
        response = await fetch(`${BRIDGE}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      } catch (error) {
        return { ok: false, code: 'http', message: error?.message ?? String(error) };
      }
      try {
        return await response.json();
      } catch {
        return { ok: false, code: 'http', message: `HTTP ${response.status}` };
      }
    }

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '680px' },
      intro: { margin: 0, fontSize: '13px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' },
      label: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '96px',
        resize: 'vertical',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      button: {
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1,
        padding: '7px 12px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      primary: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
      },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-state-idle-primary)' },
      warn: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-state-warn-primary)' },
      error: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-state-success-primary)' },
      list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: '1.7', color: 'var(--dsw-alias-state-error-primary)' },
      hint: { margin: 0, fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-state-idle-primary)' },
    };

    function button(key, t, style, onClick, disabled) {
      return h(
        'button',
        { type: 'button', onClick, disabled, style: { ...style, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' } },
        t(key),
      );
    }

    function ConfigPage(props) {
      // t 由渲染器注入（注册项的 locale）；万一没注入也不能抛 —— 抛错的组件会把整个 slot 条目
      // 变成 "slot entry crashed"，插件页那一块直接空白。
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [text, setText] = React.useState('');
      const [saved, setSaved] = React.useState('');
      const [missing, setMissing] = React.useState([]);
      const [overridden, setOverridden] = React.useState(false);
      const [invalid, setInvalid] = React.useState([]);
      const [message, setMessage] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      // 页面每次打开都重新读一次：值可能被手改过 profile patch，也可能被"清除覆盖"过。
      React.useEffect(() => {
        let alive = true;
        post('describe').then((result) => {
          if (!alive) return;
          accept(result);
        });
        return () => {
          alive = false;
        };
      }, []);

      function accept(result) {
        if (result.ok === true) {
          setText(result.value.text);
          setSaved(result.value.text);
          setMissing(result.value.missing ?? []);
          setOverridden(result.value.overridden === true);
          setInvalid([]);
          return;
        }
        if (result.code === 'invalid-dirs') {
          setInvalid(result.invalid ?? []);
          setMessage(null);
          return;
        }
        const key = CODE_KEY[result.code] ?? 'errGeneric';
        setMessage({ tone: 'error', text: t(key, { code: result.code ?? 'error', message: result.message ?? '' }) });
      }

      async function run(action, body, doneKey) {
        setBusy(true);
        setMessage(null);
        try {
          const result = await post(action, body);
          accept(result);
          if (result.ok === true) setMessage({ tone: 'ok', text: t(doneKey) });
        } finally {
          setBusy(false);
        }
      }

      const dirty = text !== saved;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

      return h(
        'section',
        { style: S.section, 'data-plugin-config-page': 'dsh-extension-cdp' },
        h('p', { style: S.intro }, t('intro')),
        h('label', { style: S.label, htmlFor: 'dsh-extension-cdp-workspaces' }, t('label')),
        h('textarea', {
          id: 'dsh-extension-cdp-workspaces',
          style: S.textarea,
          value: text,
          spellCheck: false,
          placeholder: t('placeholder'),
          onChange: (event) => setText(event.target.value),
        }),
        lines.length === 0 ? h('p', { style: S.muted }, t('emptyHint')) : null,
        missing.length > 0 ? h('p', { style: S.warn }, t('missingWarn', { dirs: missing.join('  ·  ') })) : null,
        invalid.length > 0
          ? h(
              'div',
              null,
              h('p', { style: S.error }, t('invalidTitle')),
              h(
                'ul',
                { style: S.list },
                invalid.map((item, index) =>
                  h('li', { key: `${index}:${item.input}` }, `${item.input} — ${t(REASON_KEY[item.reason] ?? 'reasonUnreadable')}`),
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: S.row },
          button('pick', t, S.button, async () => {
            const picked = await props.pickDirectory?.();
            if (typeof picked === 'string' && picked !== '') setText((current) => (current.trim() === '' ? picked : `${current.replace(/\s+$/, '')}\n${picked}`));
          }, busy || typeof props.pickDirectory !== 'function'),
          button('save', t, { ...S.button, ...S.primary }, () => run('save', { dirs: lines }, 'saved'), busy || !dirty),
          overridden ? button('reset', t, S.button, () => run('reset', {}, 'resetDone'), busy) : null,
        ),
        message === null ? null : h('p', { style: message.tone === 'ok' ? S.ok : S.error }, message.text),
        dirty ? h('p', { style: S.muted }, t('dirty')) : null,
        h('p', { style: S.hint }, t('pickHint')),
      );
    }

    const inject = ['slots'];

    function apply(ctx) {
      // 文案走 Client locale 服务（注册项的 `locale` 让渲染器把 t 绑到本命名空间：
      // ui-renderer 的 localeSeat → face.bind(ns)）。locale 可能比本行晚就绪，
      // 所以用 ctx.inject 等它：直接在 apply 里访问 ctx.locale 会在没就绪时抛错，
      // 把整行标成 failed（浏览器侧启动审计会因为非 active 的条目直接报错）。
      ctx.inject(['locale'], (sctx) => {
        for (const [locale, dict] of Object.entries(I18N)) {
          sctx.effect(() => sctx.locale.register(NS, locale, dict));
        }
      });

      // 目录选择器是可选的：拿不到就只留手填（不 inject 会让整页在缺服务的组合里报错）。
      const picker = { current: null };
      ctx.inject(['uiWorkspace'], (sctx) => {
        picker.current = () => sctx.uiWorkspace.pickDirectory();
        sctx.effect(() => () => {
          picker.current = null;
        });
      });

      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.row.config',
            // <包名>#<patch 里声明的行 id>：这一行就是 MCP 那一行（白名单写在它的 env 里）。
            key: 'dsh-extension-cdp#dsh-extension-cdp',
            locale: NS,
            inject: () => ({ pickDirectory: () => picker.current?.() }),
          },
          (slotProps) =>
            slotProps && slotProps.view === 'summary' ? slotProps.t('summary') : h(ConfigPage, slotProps),
        ),
      );
    }

    return { inject, apply };
  },
});
