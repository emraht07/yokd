// Vercel Serverless Function: /api/gemini
// Ortam değişkenleri (Vercel > Settings > Environment Variables):
//   GEMINI_API_KEY  (zorunlu)
//   GEMINI_MODEL    (opsiyonel, varsayılan: gemini-3.8-flash)

const LEVELS = {
  1: 'temel (A2-B1): kısa cümleler, sık kullanılan akademik kelimeler',
  2: 'orta (B1-B2): orta uzunlukta cümleler, akademik bağlaçlar ve kalıplar',
  3: 'ileri (B2-C1): gerçek YÖKDİL zorluğu, uzun ve yoğun akademik cümleler',
};

const TYPES =
  'kelime, gramer, cloze (boşluk doldurma), cümle tamamlama, çeviri EN→TR, çeviri TR→EN, paragraf tamamlama, anlam bütünlüğünü bozan cümle, okuma parçası';

function buildPrompt({ mode, stage, topic, count, avoid }) {
  const lvl = LEVELS[stage] || LEVELS[1];
  const skip = avoid && avoid.length ? ` Şu kelimeleri tekrar etme: ${avoid.join(', ')}.` : '';
  if (mode === 'daily') {
    return `Sen YÖKDİL Sosyal Bilimler hazırlık uzmanısın. Seviye: ${lvl}. Konu: ${topic}. İki parça üret. ` +
      `(1) Bu konuda sınavda sık çıkan 10 akademik İngilizce kelime/kalıp.${skip} ` +
      `(2) ${count} adet ÖZGÜN, YÖKDİL tarzı, 5 şıklı çoktan seçmeli soru; türleri karışık: ${TYPES}. ` +
      `Gerçek ÖSYM sorularını kopyalama. Doğru cevap şıklara dengeli dağılsın. ` +
      `Sadece JSON nesne döndür: {"words":[{"en":"","tr":"","example":""}],` +
      `"questions":[{"type":"","passage":"(yalnızca okuma/paragraf sorularında, yoksa boş)","q":"","options":["","","","",""],"answer":0,"why":"Türkçe kısa açıklama"}]} — answer 0-4 arası indeks.`;
  }
  if (mode === 'words') {
    return `Sen YÖKDİL Sosyal Bilimler hazırlık uzmanısın. Seviye: ${lvl}. Konu: ${topic}. ` +
      `Bu konuda sınavda sık çıkan ${count} akademik İngilizce kelime/kalıp seç.${skip} ` +
      `Sadece JSON dizi döndür: [{"en":"","tr":"","example":"İngilizce örnek cümle"}]`;
  }
  return `Sen YÖKDİL Sosyal Bilimler hazırlık uzmanısın. Seviye: ${lvl}. Konu: ${topic}. ` +
    `${count} adet ÖZGÜN, YÖKDİL tarzı, 5 şıklı çoktan seçmeli soru üret. Türleri karışık olsun: ${TYPES}. ` +
    `Gerçek ÖSYM sorularını kopyalama; üslup ve yapıyı taklit et. Doğru cevap şıklara dengeli dağılsın. ` +
    `Sadece JSON dizi döndür: [{"type":"","passage":"(yalnızca okuma/paragraf sorularında, yoksa boş)",` +
    `"q":"soru kökü","options":["A şıkkı","B şıkkı","C şıkkı","D şıkkı","E şıkkı"],"answer":0,` +
    `"why":"Türkçe kısa açıklama"}] — answer 0-4 arası indeks.`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST gerekli' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY tanımlı değil' });

  const b = req.body || {};
  const mode = ['words', 'daily'].includes(b.mode) ? b.mode : 'quiz';
  const stage = [1, 2, 3].includes(b.stage) ? b.stage : 1;
  const count = Math.min(Math.max(parseInt(b.count) || 10, 1), 15);
  const topic = String(b.topic || 'sosyoloji').slice(0, 60);
  const avoid = Array.isArray(b.avoid) ? b.avoid.slice(0, 80).map((s) => String(s).slice(0, 40)) : [];

  // Yoğunlukta (429/503) kısa aralıklarla tekrar dener; varsa yedek modele geçer.
  // Opsiyonel ortam değişkeni: GEMINI_FALLBACK_MODEL
  const models = [process.env.GEMINI_MODEL || 'gemini-3.8-flash'];
  if (process.env.GEMINI_FALLBACK_MODEL) models.push(process.env.GEMINI_FALLBACK_MODEL);
  const body = JSON.stringify({
    contents: [{ parts: [{ text: buildPrompt({ mode, stage, topic, count, avoid }) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr = 'Gemini hatası';

  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body }
        );
        const data = await r.json();
        if (r.ok) {
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
          return res.status(200).json({ items: JSON.parse(text) });
        }
        lastErr = data.error?.message || 'Gemini hatası';
        if (r.status === 429) { // kota: tekrar denemek kotayı daha da yer, süreyi istemciye bildir
          const m = /retry in ([\d.]+)s/i.exec(lastErr);
          return res.status(429).json({ error: lastErr, retry: m ? Math.ceil(parseFloat(m[1])) : 30 });
        }
        if (r.status !== 503) break; // kalıcı hata
        await sleep(1500);
      } catch (e) {
        lastErr = String(e.message || e);
        await sleep(1000);
      }
    }
  }
  return res.status(502).json({ error: lastErr });
};
