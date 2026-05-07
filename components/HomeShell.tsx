"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MapPointItem } from "@/lib/analysis-types";
import Sam3Panel from "@/components/Sam3Panel";

const RoadMap = dynamic(() => import("@/components/RoadMap"), { ssr: false });

const SAMPLE_TEXT = `На ул. Карла Маркса опять провал — проехать нереально после дождя.
Проспект Ленина у ТЦ «Рубин» давно нуждается в ямочном ремонте, ямы по всей ширине полосы.
Переулок Нахановича утопает в луже уже неделю, жаловались несколько раз.
улица Сергея Лазо — трещины на всём участке от остановки до поворота.
Проспект Фрунзе возле остановки «Батенькова» — глубокая яма, опасно для велосипедистов.`;

type AnalyzeJson = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  explanation?: string;
  providerUsed?: string | null;
  items?: MapPointItem[];
};

type TomskNotesJson = {
  ok: boolean;
  error?: string;
  text?: string;
};

export default function HomeShell() {
  const [text, setText] = useState("");
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesLoadNote, setNotesLoadNote] = useState<string | null>(null);
  const [items, setItems] = useState<MapPointItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [explain, setExplain] = useState<string | undefined>();

  const hasPoints = items.length > 0;

  const exportJson = useMemo(
    () => JSON.stringify(items, null, 2),
    [items],
  );

  const loadTomskNotes = useCallback(async () => {
    setNotesLoading(true);
    setNotesLoadNote(null);
    setError(null);
    try {
      const res = await fetch("/api/tomsk-notes");
      const data = (await res.json()) as TomskNotesJson;
      if (data.ok && data.text) {
        setText(data.text);
        setNotesLoadNote(
          "Загружены заметки OpenStreetMap для Томска и при необходимости дополнены синтетическими строками (с маркировкой источника).",
        );
        setError(null);
        return;
      }
      if (!data.ok && data.text) {
        setText(data.text);
        setNotesLoadNote(
          data.error
            ? `Основной API недоступен (${data.error}). Показан резерв синтетических строк.`
            : "Загрузка недоступна — показан резерв синтетических строк.",
        );
        setError(null);
        return;
      }
      setText("");
      setNotesLoadNote(data.error ?? "Не удалось получить данные OSM Notes.");
      setError(
        data.error ??
          "Не удалось загрузить демонстрационный текст из OpenStreetMap.",
      );
    } catch {
      setNotesLoadNote("Сеть недоступна — нажмите «Загрузить пример» для офлайн‑смоука или повторите позже.");
      setText("");
      setError("Сеть недоступна при загрузке OSM заметок.");
    } finally {
      setNotesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTomskNotes();
  }, [loadTomskNotes]);

  async function runAnalyze() {
    setLoading(true);
    setError(null);
    setWarnings([]);
    setExplain(undefined);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      let data: AnalyzeJson;
      try {
        data = (await res.json()) as AnalyzeJson;
      } catch {
        setError(
          `Ответ сервера не JSON (HTTP ${res.status}). Часто это таймаут или падение функции — попробуйте короче текст или повторите.`,
        );
        setItems([]);
        return;
      }
      if (!res.ok || !data.ok || !Array.isArray(data.items)) {
        setError(data.error ?? `Запрос завершился с ошибкой (HTTP ${res.status}).`);
        setItems([]);
        return;
      }
      setItems(data.items);
      setWarnings(data.warnings ?? []);
      setExplain(data.explanation);
    } catch {
      setError("Сеть недоступна или сервер недоступен.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">УК Томской области — демо</p>
          <h1>Карта дорожных жалоб</h1>
          <p className="lede">
            Текст по умолчанию подтягивается из OpenStreetMap API заметок
            (рамка Томска); при нехватке строк добавляются синтетические
            жалобы по темам публичных новостных материалов о дорогах (с явной
            пометкой). Карта построена на Leaflet с подложкой Esri Gray (при сбое
            CDN включается запасная CARTO).
          </p>
        </div>
        <div className="tag">Прототип</div>
      </header>

      <section className="grid">
        <div className="panel">
          <div className="panel-header">
            <h2>Текстовые жалобы</h2>
            <div className="actions">
              <button
                type="button"
                className="ghost"
                disabled={notesLoading}
                onClick={() => loadTomskNotes()}
              >
                Обновить OSM
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setText(SAMPLE_TEXT)}
              >
                Загрузить пример
              </button>
              <button
                type="button"
                className="primary"
                disabled={loading}
                onClick={runAnalyze}
              >
                {loading ? "Анализ…" : "Анализировать"}
              </button>
            </div>
          </div>
          {notesLoading ? (
            <p className="muted">Загружаются заметки OpenStreetMap…</p>
          ) : notesLoadNote ? (
            <p className="muted small">{notesLoadNote}</p>
          ) : null}
          <label className="label" htmlFor="comments">
            Комментарии и посты
          </label>
          <textarea
            id="comments"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            placeholder="Ожидание данных из OSM Notes или вставьте свой текст построчно…"
          />
          {error ? <p className="error">{error}</p> : null}
          {warnings.length ? (
            <div className="banner warn">
              <strong>Предупреждения</strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {explain ? <p className="muted">{explain}</p> : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Адрес</th>
                  <th>Упоминаний</th>
                  <th>1‑10</th>
                  <th>Кратко</th>
                </tr>
              </thead>
              <tbody>
                {hasPoints ? (
                  items.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="cell-title">{row.locationRaw}</div>
                        <div className="muted small">{row.normalizedAddress}</div>
                      </td>
                      <td>{row.frequency}</td>
                      <td>
                        <span className={`badge sev-${row.severity}`}>
                          {row.severity}
                        </span>
                      </td>
                      <td>{row.summary}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="empty">
                      После анализа здесь появится структурированная таблица.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="export">
            <div>
              <div className="label">Экспорт JSON</div>
              <textarea
                readOnly
                rows={6}
                value={hasPoints ? exportJson : "{}"}
                aria-label="JSON для карт или BI"
              />
            </div>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                navigator.clipboard.writeText(exportJson);
              }}
            >
              Копировать
            </button>
          </div>
        </div>

        <div className="map-panel">
          <div className="panel-header sticky">
            <h2>Карта проблемных участков</h2>
          </div>
          {!hasPoints ? (
            <div className="map-placeholder">
              <p>
                Нажмите «Анализировать». Точки из заметок OSM уже содержат
                координаты из API; синтетические строки («синтетика для демо…»)
                обрабатываются как свободный текст с геокодированием там, где это
                удаётся. Кнопка «Загрузить пример» воспроизводит локальный смоук
                без сетевых источников.
              </p>
            </div>
          ) : (
            <RoadMap points={items} />
          )}
        </div>
      </section>

      <Sam3Panel />
    </div>
  );
}
