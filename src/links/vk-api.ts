// ─── VK API ─────────────────────────────────────────────────

export const VK_GROUP_TOKEN = process.env.VK_GROUP_TOKEN || "";
export const VK_GROUP_ID = process.env.VK_GROUP_ID || "";
export const isVkConfigured = !!(VK_GROUP_TOKEN && VK_GROUP_ID);

/** Публикует ссылку новым постом на стене закрытой VK-группы */
export async function publishToVk(link: string): Promise<{ ok: boolean; error?: string }> {
  if (!isVkConfigured) {
    return { ok: false, error: "Публикация в VK не настроена" };
  }

  try {
    const params = new URLSearchParams({
      access_token: VK_GROUP_TOKEN,
      owner_id: `-${VK_GROUP_ID}`,
      from_group: "1",
      message: link,
      v: "5.199",
    });

    const res = await fetch("https://api.vk.com/method/wall.post", {
      method: "POST",
      body: params,
    });

    const data = await res.json() as {
      response?: { post_id: number };
      error?: { error_code: number; error_msg: string };
    };

    if (data.error) {
      const { error_code, error_msg } = data.error;
      return { ok: false, error: `VK API ${error_code}: ${error_msg}` };
    }

    if (data.response?.post_id) {
      return { ok: true };
    }

    return { ok: false, error: "VK API: неожиданный ответ" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `VK API: ${msg}` };
  }
}
