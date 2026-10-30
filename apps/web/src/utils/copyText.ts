// Fix 6.7: "Copy" buttons that also work over plain HTTP.
// إصلاح 6.7: أزرار النسخ تشتغل حتى على HTTP العادي.
//
// navigator.clipboard only exists in a secure context (HTTPS or localhost),
// so on the hosted server (http://<ip>) "Copy link" and "Copy secret" did
// nothing. Fallback: put the text in a hidden textarea and use the older
// document.execCommand("copy"), which browsers still allow after a click.
// navigator.clipboard يشتغل بس في HTTPS أو localhost، فعلى السيرفر زر النسخ
// ما كان يسوي شي. الحل: نحط النص في خانة مخفية وننسخه بالطريقة القديمة.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the fallback / نكمل للطريقة الثانية
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}