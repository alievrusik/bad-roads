"use client";

import { useMemo, useState } from "react";

type Detection = {
  id: string;
  labelEn: string;
  score?: number;
  polygon?: [number, number][];
  bbox?: { x: number; y: number; width: number; height: number };
};

type Sam3Response = {
  ok: boolean;
  warnings: string[];
  diagnostics?: {
    processingMode?: string;
    outputKind?: string;
    upstreamStatus?: number;
    attemptUsed?: string;
    message?: string;
  };
  textPromptEn: string;
  previewDataUrl: string | null;
  overlayDataUrl: string | null;
  detections: Detection[];
  rawJson?: unknown;
};

const PRESETS_EN = [
  { key: "pothole-asphalt", label: "Выбоины и сколы асфальта", en: "pothole and damaged asphalt" },
  { key: "crack", label: "Трещины", en: "crack in roadway surface" },
  { key: "patch", label: "Неровная заплатка / стык", en: "rough asphalt patch junction" },
  { key: "marking-wear", label: "Стёртая разметка", en: "faded road lane marking" },
] as const;

export default function Sam3Panel() {
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState<string>(PRESETS_EN[0]!.key);
  const customEn = PRESETS_EN.find((p) => p.key === preset)?.en ?? "";
  const [extraEn, setExtraEn] = useState("");
  const [loading, setLoading] = useState(false);
  const [warn, setWarn] = useState<string[]>([]);
  const [result, setResult] = useState<Sam3Response | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });

  const promptEn =
    `${customEn}${extraEn.trim() ? `, ${extraEn.trim()}` : ""}`.trim();

  async function submit() {
    if (!file) {
      setWarn(["Загрузите изображение в формате JPG или PNG."]);
      setResult(null);
      return;
    }
    setLoading(true);
    setWarn([]);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("text_prompt", promptEn);
      fd.append("return_preview", "true");
      fd.append("return_overlay", "true");

      const res = await fetch("/api/sam3-image", {
        method: "POST",
        body: fd,
      });
      const data = (await res.json()) as Sam3Response;
      setResult(data);
      setWarn(data.warnings ?? []);
      setNatural({ w: 0, h: 0 });
    } catch {
      setWarn(["Не удалось обратиться к серверной сегментации."]);
    } finally {
      setLoading(false);
    }
  }

  const primarySrc =
    result?.overlayDataUrl ??
    result?.previewDataUrl ??
    null;

  const exportBody = useMemo(
    () => JSON.stringify(result, null, 2),
    [result],
  );

  return (
    <section className="sam-section">
      <div className="sam-header">
        <div>
          <p className="eyebrow">Дополнительно</p>
          <h2>Визуальная локализация участка дороги</h2>
          <p className="lede muted">
            Загрузите фото: сервер отправляет изображение в модель сегментации
            с текстовым запросом на английском (класс объекта задаётся вне
            интерфейса для точности модели).
          </p>
        </div>
      </div>

      <div className="sam-grid">
        <div className="sam-controls">
          <label className="label" htmlFor="photo">
            Фотография дороги
          </label>
          <input
            id="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <label className="label" htmlFor="preset-select">
            Сценарий (классы на английском отправляются на сервер автоматически)
          </label>
          <select
            id="preset-select"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            {PRESETS_EN.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <label className="label" htmlFor="extra-en">
            Дополнительные термины (English, необязательно)
          </label>
          <input
            id="extra-en"
            type="text"
            value={extraEn}
            placeholder="broken curb, pooled water..."
            onChange={(e) => setExtraEn(e.target.value)}
          />
          <p className="hint">
            Сервер отправит{" "}
            <code>{promptEn || "preset"}</code> в качестве text_prompt .
          </p>
          <button
            type="button"
            className="primary"
            disabled={loading}
            onClick={submit}
          >
            {loading ? "Отправляем изображение…" : "Сегментировать"}
          </button>
          {warn.length ? (
            <div className="banner warn">
              <strong>Информация</strong>
              <ul>
                {warn.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {result?.diagnostics ? (
            <div className="meta">
              <div>
                <span className="muted">processingMode:</span>{" "}
                {result.diagnostics.processingMode ?? "—"}
              </div>
              <div>
                <span className="muted">outputKind:</span>{" "}
                {result.diagnostics.outputKind ?? "—"}
              </div>
              <div>
                <span className="muted">upstreamStatus:</span>{" "}
                {result.diagnostics.upstreamStatus ?? "—"}
              </div>
              <div>
                <span className="muted">message:</span>{" "}
                {result.diagnostics.message ?? "—"}
              </div>
            </div>
          ) : null}
        </div>

        <div className="sam-visual">
          <div className="sam-split">
            <div>
              <h3 className="subhead">Исходник / наложение</h3>
              <div className="figure">
                {primarySrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={primarySrc}
                    alt="Результат сегментации"
                    style={{ width: "100%", height: "auto", display: "block" }}
                    onLoad={(ev) =>
                      setNatural({
                        w: ev.currentTarget.naturalWidth || 640,
                        h: ev.currentTarget.naturalHeight || 420,
                      })
                    }
                  />
                ) : (
                  <div className="empty-box">
                    После отправки здесь будет предварительный просмотр.
                  </div>
                )}
                {primarySrc ? (
                  <svg
                    className="overlay"
                    preserveAspectRatio="xMidYMid meet"
                    viewBox={`0 0 ${natural.w || 640} ${natural.h || 420}`}
                  >
                    {result?.detections?.map((d) => (
                      <g key={d.id}>
                        {d.polygon && d.polygon.length > 2 ? (
                          <polygon
                            fill="rgba(239,68,68,0.2)"
                            stroke="#f97316"
                            strokeWidth={4}
                            points={d.polygon.map((p) => p.join(",")).join(" ")}
                          />
                        ) : null}
                        {d.bbox ? (
                          <rect
                            x={d.bbox.x}
                            y={d.bbox.y}
                            width={d.bbox.width}
                            height={d.bbox.height}
                            fill="none"
                            stroke="#38bdf8"
                            strokeDasharray="6 8"
                            strokeWidth={5}
                          />
                        ) : null}
                      </g>
                    ))}
                  </svg>
                ) : null}
              </div>
            </div>
            <div>
              <h3 className="subhead">Отдельное окно наложения / превью</h3>
              <div className="figure muted-border">
                {result?.previewDataUrl && result.previewDataUrl !== primarySrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.previewDataUrl}
                    alt="Превью маски"
                    style={{ width: "100%", height: "auto" }}
                  />
                ) : primarySrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={primarySrc}
                    alt="Зеркально для отсутствующего второго канала"
                    style={{ width: "100%", height: "auto" }}
                  />
                ) : (
                  <div className="empty-box">
                    Если сервер возвращает только один визуальный канал,
                    здесь будет зеркально скопировано изображение.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="detections-block">
            <div className="panel-header slim">
              <h3>Список детекций</h3>
              <button
                type="button"
                className="ghost small"
                onClick={() => navigator.clipboard.writeText(exportBody)}
              >
                Копировать JSON
              </button>
            </div>
            <div className="detections-scroll">
              {result?.detections?.length ? (
                <ul className="det-list">
                  {result.detections.map((d) => (
                    <li key={d.id}>
                      <div className="det-title">{d.labelEn}</div>
                      <div className="muted small">id: {d.id}</div>
                      <div>
                        Уверенность:{" "}
                        <strong>
                          {typeof d.score === "number"
                            ? `${Math.round(d.score * 100) / 100}`
                            : "—"}
                        </strong>
                      </div>
                      {d.polygon?.length ? (
                        <div className="muted small">
                          Полигон: {d.polygon.length} точек
                        </div>
                      ) : null}
                      {d.bbox ? (
                        <div className="muted small">
                          bbox x:{Math.round(d.bbox.x)}, y:{Math.round(d.bbox.y)}, w:
                          {Math.round(d.bbox.width)}, h:{Math.round(d.bbox.height)}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty-box slim">
                  Список детекций появится при успешной сегментации или в
                  демонстрационном режиме.
                </div>
              )}
              <textarea
                aria-label="JSON ответ сервера"
                readOnly
                rows={8}
                className="mono"
                value={result ? exportBody : "{}"}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
