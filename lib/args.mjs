// 交给 chrome-devtools-mcp 的参数：端点必须在最前，env 派生的 --workspace 次之，
// 用户/包配置的参数原样追加在最后（同名的标量选项以后者为准；--workspace 是可重复的数组，两者累加）。
export function workspaceFlags(workspaces = []) {
  return (workspaces ?? []).flatMap((dir) => ['--workspace', dir]);
}

export function buildServerArgs({ entry, wsUrl, extraArgs = [], workspaces = [] } = {}) {
  return [entry, '--wsEndpoint', wsUrl, ...workspaceFlags(workspaces), ...(extraArgs ?? [])];
}
