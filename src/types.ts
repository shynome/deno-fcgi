/** 主线程与 Worker 之间传递的数据结构 */

export interface ScriptJob {
  /** 脚本的 file:// URL，Worker 用它加载入口脚本 */
  scriptUrl: string;
  /** 脚本的绝对路径，用于把 read 权限精确限到这一个文件 */
  scriptPath: string;
  /** 本次请求的 CGI 环境变量 */
  env: Record<string, string>;
  /** 请求体，对应 CGI 的 stdin */
  body: Uint8Array;
}

export interface ScriptErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/** 脚本以 `export default { fetch }` 形式导出时，Worker 返回结构化响应 */
export interface ScriptResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: Uint8Array;
}

export type ScriptMode = "ephemeral" | "resident";

export interface ScriptResult {
  status: "ok" | "error";
  /**
   * ephemeral：顶层执行式脚本，Worker 用完即弃
   * resident：`export default { fetch }`，Worker 可常驻复用
   */
  mode: ScriptMode;
  /** CGI 风格的 stdout（console.log 等），仅在无 response 时使用 */
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** 结构化响应，优先于 stdout */
  response?: ScriptResponse;
  error?: ScriptErrorInfo;
}
