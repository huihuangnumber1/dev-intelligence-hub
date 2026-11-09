import { runJson } from "../lib/command-runner.js";
import { mailItem } from "../domain/dingtalk-mail.js";

function responseData(value) {
  if (!value || value.success === false || value.success === "false") {
    throw new Error("邮件读取失败，请检查钉钉邮箱授权后刷新。");
  }
  return value;
}

export class DingTalkMailAdapter {
  constructor({ run = runJson, ownerLogin = "" } = {}) {
    this.run = run;
    this.ownerLogin = ownerLogin;
    this.cache = new Map();
  }

  async collect(now, options = {}) {
    try {
      const accounts = responseData(await this.run("dws", ["mail", "mailbox", "list", "--format", "json"], options));
      const enterprise = (accounts.emailAccounts || []).filter((account) => account.type === "ORG" && account.email);
      if (enterprise.length !== 1) throw new Error("MAIL_ACCOUNT_AMBIGUOUS");
      const mailbox = enterprise[0].email;
      const start = new Date(now.getTime() - 86_400_000).toISOString();
      let cursor = "";
      const cursors = new Set();
      const messages = new Map();
      do {
        options.signal?.throwIfAborted();
        const page = responseData(await this.run("dws", ["mail", "message", "search", "--email", mailbox,
          "--query", `folderId:2 AND date>${start} AND date<${now.toISOString()}`,
          "--limit", "100", ...(cursor ? ["--cursor", cursor] : []), "--format", "json"], options));
        if (!Array.isArray(page.messages) || typeof page.nextCursor !== "string") throw new Error("MAIL_RESPONSE_INVALID");
        for (const message of page.messages) {
          if (!message.id) throw new Error("MAIL_RESPONSE_INVALID");
          messages.set(message.id, message);
        }
        cursor = page.nextCursor;
        if (cursor && cursor !== "$" && cursors.has(cursor)) throw new Error("MAIL_CURSOR_REPEATED");
        cursors.add(cursor);
      } while (cursor && cursor !== "$");

      const missing = [...messages.keys()].filter((id) => !this.cache.has(`${mailbox}\0${id}`));
      for (let index = 0; index < missing.length; index += 20) {
        options.signal?.throwIfAborted();
        const ids = missing.slice(index, index + 20);
        const batch = responseData(await this.run("dws", ["mail", "message", "batch-get", "--email", mailbox,
          "--ids", ids.join(","), "--format", "json"], options));
        const received = new Map();
        for (const entry of batch.messages || []) {
          const detail = responseData(entry.result).message;
          if (entry.id !== detail?.id || !ids.includes(entry.id) || typeof detail.markdownBody !== "string" ||
              !Number.isFinite(Date.parse(detail.receivedDateTime))) throw new Error("MAIL_RESPONSE_INVALID");
          received.set(entry.id, mailItem(detail, { mailbox, ownerLogin: this.ownerLogin }));
        }
        if (received.size !== ids.length) throw new Error("MAIL_RESPONSE_INCOMPLETE");
        for (const [id, item] of received) this.cache.set(`${mailbox}\0${id}`, item);
      }
      const active = new Set([...messages.keys()].map((id) => `${mailbox}\0${id}`));
      for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key);
      return [...active].map((key) => this.cache.get(key)).filter((item) =>
        Date.parse(item.updatedAt) > Date.parse(start) && Date.parse(item.updatedAt) <= now.getTime());
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new Error(error.message === "MAIL_ACCOUNT_AMBIGUOUS"
        ? "未找到唯一的企业邮箱，请检查当前钉钉账号的企业邮箱配置。"
        : "邮件本轮未能更新，已保留上次摘要；请检查钉钉邮箱授权或稍后重试。", { cause: error });
    }
  }
}
