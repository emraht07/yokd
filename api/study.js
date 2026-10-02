// Vercel Serverless Function: /api/study
// Ortam değişkenleri:
//   GEMINI_API_KEY        (zorunlu)
//   GEMINI_MODEL          (opsiyonel, varsayılan: gemini-3.8-flash)
//   OPENROUTER_API_KEY    (opsiyonel, Gemini kotası dolunca yedek)
//   OPENROUTER_MODELS     (opsiyonel, virgülle ayrılmış :free model adları)

const SHAPE = `{
  "title": "kısa başlık",
  "field": "", "topic": "",
  "lesson": "Markdown: ## başlıklar, **kalın**, - listeler, > not. Türkçe anlatım, İngilizce örneklerle.",
  "questions": [{"question":"","options":["","","","",""],"answer":0,"explanation":"Türkçe kısa açıklama"}],
  "vocabulary": [{"word":"","pos":"noun/verb/adj/adv","meaning":"Türkçe","example":"İngilizce cümle","translation":"Türkçe çeviri","synonyms":"eş anlamlılar"}],
  "strategies": [{"title":"","detail":"","example":""}]
}`;

function buildPrompt(b) {
  const kind = String(b.kind || '');
  let need = 'lesson (kısa ders) ve 3 soru';
  if (/kelime/i.test(kind)) need = 'vocabulary (12 kelime); lesson kısa bir giriş olsun';
  else if (/soru|deneme/i.test(kind)) need = `questions (tam ${b.questionCount || 5} adet); lesson boş bırakılabilir`;
  else if (/taktik/i.test(kind)) need = 'strategies (5 taktik) ve lesson (kısa uygulama) ve 3 soru';
  else if (/çeviri|paragraf/i.test(kind)) need = 'lesson (analiz/atölye, örneklerle) ve 3 soru';

  const nonce = Math.random().toString(36).slice(2, 8);
  return `Sen YÖKDİL hazırlık öğretmenisin. Alan: ${b.field}. Seviye: ${b.level}. Konu: ${b.topic}. ` +
    `Çalışma türü: ${kind}. Süre: ${b.minutes}. Zayıf yön: ${b.weakness || 'belirtilmedi'}. ` +
    `Bugünün tarihi: ${new Date().toISOString().slice(0, 10)}, varyasyon kodu: ${nonce} (her seferinde farklı içerik üret). ` +
    `Üret: ${need}. Sorular 5 şıklı (A-E) YÖKDİL tarzında özgün olsun, gerçek ÖSYM sorusu kopyalama; ` +
    `answer 0-4 indeks, doğru cevap dengeli dağılsın. Alan sosyal bilimlerse konular sosyoloji, psikoloji, ` +
    `siyaset bilimi, iktisat, eğitim, tarih, hukuk gibi alanlardan seçilsin. ` +
    `Sadece şu şekle uyan JSON nesnesi döndür, kullanmadığın alanları boş dizi/boş metin yap:\n${SHAPE}`;
}

const parse = (t) => JSON.parse(String(t).replace(/^```json|```$/g, '').trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gemini(prompt, key) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
      }),
    });
    const d = await r.json();
    if (r.ok) return { data: parse(d.candidates?.[0]?.content?.parts?.[0]?.text || '{}') };
    const msg = d.error?.message || 'Gemini hatası';
    if (r.status === 429) {
      const m = /retry in ([\d.]+)s/i.exec(msg);
      return { quota: true, wait: m ? Math.ceil(parseFloat(m[1])) : 60 };
    }
    if (r.status !== 503 || i === 1) return { error: msg };
    await sleep(1500);
  }
  return { error: 'Gemini yanıt vermedi' };
}

async function openrouter(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  const models = (process.env.OPENROUTER_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key || !models.length) return null;
  for (const model of models) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      });
      const d = await r.json();
      if (r.ok) return parse(d.choices?.[0]?.message?.content || '{}');
    } catch (e) { /* sıradaki modeli dene */ }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST gerekli' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY tanımlı değil' });

  const b = req.body || {};
  const clean = (v, n) => String(v ?? '').slice(0, n);
  const input = {
    field: clean(b.field, 60), level: clean(b.level, 60), topic: clean(b.topic, 80),
    kind: clean(b.kind, 60), minutes: clean(b.minutes, 20), weakness: clean(b.weakness, 200),
    questionCount: Math.min(Math.max(parseInt(b.questionCount) || 5, 1), 12),
  };
  const prompt = buildPrompt(input);

  try {
    const g = await gemini(prompt, key);
    if (g.data) return res.status(200).json(g.data);
    const fb = await openrouter(prompt);
    if (fb) return res.status(200).json(fb);
    if (g.quota) return res.status(429).json({ error: `Gemini ücretsiz kotası doldu. Yaklaşık ${g.wait} saniye bekleyip tekrar dene.` });
    return res.status(502).json({ error: g.error || 'Gemini hatası' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
