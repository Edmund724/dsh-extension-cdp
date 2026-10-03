// 交给 chrome-devtools-mcp 的参数：端点必须在最前，用户/包配置的参数原样追加。
export function buildServerArgs({ entry, wsUrl, extraArgs = [] } = {}) {
  return [entry, '--wsEndpoint', wsUrl, ...(extraArgs ?? [])];
}
