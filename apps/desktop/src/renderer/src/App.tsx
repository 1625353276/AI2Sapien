import { useCallback, useEffect, useMemo, useState } from "react";

import type { RateLimits, RateWindow, RuntimeStatusSnapshot } from "@ai2sapien/contracts";

const navigation = [
  { label: "学习台", icon: "home", active: true },
  { label: "资料库", icon: "library", active: false },
  { label: "知识地图", icon: "map", active: false },
  { label: "练习与补救", icon: "practice", active: false },
  { label: "复习队列", icon: "review", active: false },
] as const;

export function App() {
  const [status, setStatus] = useState<RuntimeStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"login" | "logout" | "refresh" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (kind: "initial" | "refresh" = "refresh") => {
    if (kind === "refresh") setAction("refresh");
    try {
      setStatus(await window.ai2sapien.readRuntimeStatus());
      setNotice(null);
    } catch {
      setNotice("无法读取本机运行状态，请稍后再试。");
    } finally {
      setLoading(false);
      setAction(null);
    }
  }, []);

  useEffect(() => {
    void refresh("initial");
    return window.ai2sapien.onRuntimeStatusChanged((nextStatus) => {
      setStatus(nextStatus);
      setLoading(false);
      setNotice(nextStatus.auth.authenticated ? "ChatGPT 账户状态已更新。" : null);
    });
  }, [refresh]);

  const login = async () => {
    setAction("login");
    try {
      await window.ai2sapien.startBrowserLogin();
      setNotice("已在浏览器打开 ChatGPT 登录页，完成后这里会自动更新。");
    } catch {
      setNotice("无法启动 ChatGPT 登录，请确认 Codex CLI 可用。");
    } finally {
      setAction(null);
    }
  };

  const logout = async () => {
    setAction("logout");
    try {
      await window.ai2sapien.logout();
      await refresh("initial");
    } catch {
      setNotice("登出失败，请稍后重试。");
    } finally {
      setAction(null);
    }
  };

  const authenticated = status?.auth.authenticated ?? false;
  const plan = formatPlan(status?.auth.planType);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>AI</span><i>2</i></div>
          <div><strong>AI2Sapien</strong><small>人工智人</small></div>
        </div>

        <nav aria-label="主要导航">
          <p className="nav-eyebrow">学习空间</p>
          {navigation.map((item) => (
            <button className={`nav-item ${item.active ? "active" : ""}`} key={item.label} type="button">
              <NavIcon name={item.icon} />
              <span>{item.label}</span>
              {!item.active && <small>即将开放</small>}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <span className="note-orbit" aria-hidden="true" />
          <p>本地优先</p>
          <small>资料与学习记录默认留在这台电脑</small>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">LEARNING WORKSPACE</p>
            <h1>早上好，开始今天的理解之旅。</h1>
          </div>
          <div className={`connection-pill ${authenticated ? "online" : "offline"}`}>
            <span />
            {loading ? "正在连接" : authenticated ? `${plan} 已连接` : "尚未登录"}
          </div>
        </header>

        <section className="hero-grid">
          <article className="hero-card">
            <div className="hero-copy">
              <p className="eyebrow">FROM OUTPUT TO MASTERY</p>
              <h2>把 AI 的输出，<br /><em>蒸馏</em>成真正掌握。</h2>
              <p className="hero-description">
                AI2Sapien 不只告诉你答案。它寻找知识缺口，解释错误形成的原因，
                再用图像与迁移练习帮助你真正记住。
              </p>
              <div className="hero-actions">
                <button className="primary-button" type="button" disabled>
                  导入第一份资料 <span>→</span>
                </button>
                <span className="coming-tag">下一切片开放</span>
              </div>
            </div>
            <KnowledgeOrbit />
          </article>

          <RuntimeCard
            status={status}
            loading={loading}
            action={action}
            onRefresh={() => void refresh()}
            onLogin={() => void login()}
            onLogout={() => void logout()}
          />
        </section>

        {notice && <div className="notice" role="status">{notice}</div>}

        <section className="section-block">
          <div className="section-heading">
            <div><p className="eyebrow">HOW IT LEARNS WITH YOU</p><h2>一条完整的理解闭环</h2></div>
            <span>首版路线 · 01—05</span>
          </div>
          <div className="learning-loop">
            <LoopStep number="01" title="读懂材料" text="保留来源页码，提取知识点与前置关系。" active />
            <LoopStep number="02" title="诊断理解" text="用不同能力层级的问题找到真实缺口。" />
            <LoopStep number="03" title="解释错因" text="说明为什么会错，而不只是展示答案。" />
            <LoopStep number="04" title="图文补救" text="用机制图、对比和例子建立检索线索。" />
            <LoopStep number="05" title="迁移复测" text="换一个表面情境，验证是否真的掌握。" />
          </div>
        </section>
      </main>
    </div>
  );
}

function RuntimeCard({
  status,
  loading,
  action,
  onRefresh,
  onLogin,
  onLogout,
}: {
  status: RuntimeStatusSnapshot | null;
  loading: boolean;
  action: "login" | "logout" | "refresh" | null;
  onRefresh: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const primaryLimit = useMemo(() => choosePrimaryLimit(status?.rateLimits ?? []), [status]);
  const authenticated = status?.auth.authenticated ?? false;

  return (
    <article className="runtime-card">
      <div className="runtime-header">
        <div><p className="eyebrow">CODEX CONNECTION</p><h2>AI 运行状态</h2></div>
        <button className={`icon-button ${action === "refresh" ? "spinning" : ""}`} onClick={onRefresh} type="button" aria-label="刷新状态" disabled={action !== null}>
          <RefreshIcon />
        </button>
      </div>

      {loading ? (
        <div className="runtime-loading"><span /><p>正在读取本机 Codex 状态…</p></div>
      ) : authenticated && status ? (
        <>
          <div className="account-row">
            <div className="account-avatar">AI</div>
            <div><strong>ChatGPT {formatPlan(status.auth.planType)}</strong><small>{maskEmail(status.auth.email) ?? "由 Codex 安全管理登录"}</small></div>
            <span className="verified">已连接</span>
          </div>
          {primaryLimit ? <UsageMeter limit={primaryLimit} /> : <p className="muted-panel">{status.issue?.message ?? "当前没有可显示的用量窗口。"}</p>}
          <div className="runtime-footer">
            <span>更新于 {formatClock(status.checkedAt)}</span>
            <button className="text-button" type="button" onClick={onLogout} disabled={action !== null}>{action === "logout" ? "正在退出…" : "退出账户"}</button>
          </div>
        </>
      ) : (
        <div className="login-state">
          <div className="login-glyph" aria-hidden="true">↗</div>
          <h3>{status?.connected ? "连接你的 ChatGPT" : "Codex 暂时不可用"}</h3>
          <p>{status?.issue?.message ?? "登录后即可在本机使用你的 Codex 套餐。"}</p>
          <button className="secondary-button" type="button" onClick={onLogin} disabled={!status?.connected || action !== null}>
            {action === "login" ? "正在打开…" : "使用 ChatGPT 登录"}
          </button>
        </div>
      )}
    </article>
  );
}

function UsageMeter({ limit }: { limit: RateLimits }) {
  const window = limit.primary ?? limit.secondary;
  if (!window) return null;
  const remaining = Math.max(0, Math.round(100 - window.usedPercent));

  return (
    <div className="usage-panel">
      <div className="usage-label"><span>当前用量窗口</span><strong>{remaining}% <small>可用</small></strong></div>
      <div className="meter" aria-label={`剩余 ${remaining}%`}><span style={{ width: `${remaining}%` }} /></div>
      <div className="usage-meta"><span>{describeWindow(window)}</span><span>{formatReset(window)}</span></div>
    </div>
  );
}

function LoopStep({ number, title, text, active = false }: { number: string; title: string; text: string; active?: boolean }) {
  return <article className={`loop-step ${active ? "active" : ""}`}><span>{number}</span><div><h3>{title}</h3><p>{text}</p></div></article>;
}

function KnowledgeOrbit() {
  return (
    <div className="knowledge-orbit" aria-label="知识从材料经过诊断、解释和复测形成掌握的示意图">
      <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" />
      <span className="orbit-node node-a">材料</span><span className="orbit-node node-b">诊断</span><span className="orbit-node node-c">解释</span><span className="orbit-node node-d">复测</span>
      <div className="orbit-core"><strong>掌握</strong><small>MASTERY</small></div>
    </div>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11h13V9M9 20v-6h6v6"/></>,
    library: <><path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2V4Z"/><path d="M7 16h12M9 8h6"/></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></>,
    practice: <><path d="M5 3h14v18H5z"/><path d="m8 9 2 2 4-4M8 16h8"/></>,
    review: <><path d="M12 5a7 7 0 1 1-6.2 3.75"/><path d="M3 4v5h5M12 8v5l3 2"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2.05 4.95"/></svg>;
}

function choosePrimaryLimit(limits: RateLimits[]): RateLimits | null {
  return limits.find((item) => item.limitId === "codex") ?? limits[0] ?? null;
}

function formatPlan(plan: string | null | undefined): string {
  if (!plan) return "账户";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [name, domain] = email.split("@");
  if (!name || !domain) return email;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${"•".repeat(Math.max(3, Math.min(6, name.length - visible.length)))}@${domain}`;
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function describeWindow(window: RateWindow): string {
  if (!window.windowDurationMins) return "Codex 用量";
  const hours = window.windowDurationMins / 60;
  return Number.isInteger(hours) ? `${String(hours)} 小时窗口` : `${String(window.windowDurationMins)} 分钟窗口`;
}

function formatReset(window: RateWindow): string {
  if (!window.resetsAt) return "重置时间未知";
  const reset = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(window.resetsAt));
  return `${reset} 重置`;
}
