import { escapeHtml } from "./view-format.js";

const STATE_PRESENTATION = Object.freeze({
  available: Object.freeze({
    tone: "available",
    label: "能力可用",
    summary: "CLI 已安装且受支持，文件式登录可安全代理。",
    guidance: "Codex CLI 大脑可以使用当前 Windows 用户的登录状态。",
  }),
  file_login_unavailable: Object.freeze({
    tone: "attention",
    label: "登录不可用",
    summary: "CLI 已就绪，但没有发现可代理的文件式登录。",
    guidance: "请使用运行 Development Intelligence Hub 的同一 Windows 用户执行 codex login，然后重新检查。",
  }),
  unsafe_source: Object.freeze({
    tone: "blocked",
    label: "登录源不安全",
    summary: "系统拒绝读取当前 Codex 登录文件。",
    guidance: "请检查文件所有者、ACL 或链接；修复后再重新检查。",
  }),
  broker_blocked: Object.freeze({
    tone: "blocked",
    label: "凭据代理已封闭",
    summary: "本次进程中的安全边界已关闭，CLI 登录不会继续使用。",
    guidance: "请重启 Development Intelligence Hub；若仍失败，再检查本机登录文件权限。",
  }),
  cli_unavailable: Object.freeze({
    tone: "blocked",
    label: "CLI 不可用",
    summary: "系统无法安全启动受支持的 Codex CLI。",
    guidance: "请安装项目支持的 Codex CLI，并确保服务进程可以发现它。",
  }),
});

const NATIVE_STATE_PRESENTATION = Object.freeze({
  available: {
    tone: "available",
    label: "原生登录可用",
    summary: "CLI 可以使用服务账号的 Codex 登录和原生会话目录。",
    guidance: "这表示执行能力已就绪，不代表任务已经开始；请在工作台账查看实际进度。",
  },
  file_login_unavailable: {
    tone: "attention",
    label: "原生登录不可用",
    summary: "CLI 已就绪，但当前服务账号的 Codex 登录不可用。",
    guidance: "请使用运行服务的同一账号和 CODEX_HOME 执行 codex login，再重新检查。",
  },
  unsafe_source: {
    tone: "blocked",
    label: "原生运行目录不可用",
    summary: "系统无法安全使用原生执行所需的运行目录。",
    guidance: "请检查运行目录的权限和路径，保留原有 Codex 会话历史。",
  },
  broker_blocked: {
    tone: "blocked",
    label: "执行状态待核验",
    summary: "前一次 CLI 的退出或会话状态尚未确认，后续调用已暂停。",
    guidance: "请检查受管进程和运行记录；确认退出后按运维手册恢复，保留原生会话目录。",
  },
  cli_unavailable: {
    tone: "blocked",
    label: "CLI 不可用",
    summary: "系统无法安全启动支持原生执行的 Codex CLI。",
    guidance: "请检查 Codex CLI 是否支持所需命令，并确保服务账号可以发现它。",
  },
});

function shell({ body, tone = "pending", role = "status" }) {
  return `<section class="brain-provider-status-card status-${tone}" aria-labelledby="brain-provider-status-title">
    <div class="brain-provider-status-heading">
      <div>
        <p class="eyebrow">LOCAL CLI / LOGIN BROKER</p>
        <h2 id="brain-provider-status-title">Codex CLI 大脑能力</h2>
      </div>
    </div>
    <div class="brain-provider-status-body" role="${role}" aria-live="polite">${body}</div>
  </section>`;
}

export function renderBrainProviderStatus({
  state = null,
  loading = false,
  error = "",
  pendingRestart = false,
} = {}) {
  if (loading && state === null) {
    return shell({
      body: "<p>正在检查 Codex CLI 与登录能力…</p>",
    });
  }

  if (state === null) {
    const message = error || "尚未读取 Codex CLI 大脑能力。";
    return shell({
      tone: "blocked",
      role: error ? "alert" : "status",
      body: `<p>${escapeHtml(message)}</p>
        <button type="button" class="secondary-button" data-brain-provider-status-reload>重新检查</button>`,
    });
  }

  const nativeLogin = state?.credentialMode === "codex-native-login";
  const presentations = nativeLogin ? NATIVE_STATE_PRESENTATION : STATE_PRESENTATION;
  const presentation = Object.hasOwn(presentations, state?.state)
    ? presentations[state.state]
    : null;
  if (!presentation) {
    return shell({
      tone: "blocked",
      role: "alert",
      body: `<p>服务返回了无法识别的 Codex CLI 能力状态。</p>
        <button type="button" class="secondary-button" data-brain-provider-status-reload>重新检查</button>`,
    });
  }

  return shell({
    tone: presentation.tone,
    role: error ? "alert" : "status",
    body: `${pendingRestart
      ? '<p class="brain-provider-status-notice">已保存，重启后生效</p>'
      : ""}
      ${error ? `<p class="brain-provider-status-error">${escapeHtml(error)}</p>` : ""}
      <div class="brain-provider-status-heading">
        <div>
          <strong>${presentation.label}</strong>
          <p>${presentation.summary}</p>
        </div>
        <button type="button" class="secondary-button" data-brain-provider-status-reload ${loading ? "disabled" : ""}>${loading ? "检查中…" : "重新检查"}</button>
      </div>
      <dl class="brain-provider-status-facts">
        <div><dt>CLI</dt><dd>${state.cliAvailable === true ? "可用" : "不可用"}</dd></div>
        <div><dt>${nativeLogin ? "原生登录" : "文件式登录"}</dt><dd>${state.fileLoginAvailable === true ? "可用" : "不可用"}</dd></div>
      </dl>
      <p class="brain-provider-status-guidance">${presentation.guidance}</p>`,
  });
}
