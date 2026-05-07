"use client";

import { useEffect, useRef } from "react";
import type { MapPointItem } from "@/lib/analysis-types";
import type { LatLngExpression } from "leaflet";

import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";

import L from "leaflet";
import "leaflet.markercluster";

import "@/styles/leaflet-overrides.css";

type Props = {
  points: MapPointItem[];
};

function severityColor(severity: number) {
  if (severity >= 8) return "#b91c1c";
  if (severity >= 5) return "#d97706";
  return "#15803d";
}

/** Esri серый фон без прямой загрузки с tile.openstreetmap.org (устойчивее к CDN/Vercel). */
const ESRI_LIGHT_GRAY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const CARTO_LIGHT =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

export default function RoadMap({ points }: Props) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const map = L.map(mapDivRef.current, { attributionControl: true }).setView(
      { lat: 56.4884, lng: 84.9481 },
      11,
    );

    const esriAttr =
      '&copy; <a href="https://www.esri.com/">Esri</a>';
    const cartoAttr =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

    const esri = L.tileLayer(ESRI_LIGHT_GRAY, {
      maxZoom: 16,
      attribution: `${esriAttr} — базовая подложка (не OSM tile cache)`,
      crossOrigin: true,
    });
    const carto = L.tileLayer(CARTO_LIGHT, {
      maxZoom: 20,
      subdomains: "abcd",
      attribution: `${cartoAttr} — резерв при ошибках CDN`,
      crossOrigin: true,
    });

    let activeBasemap: L.TileLayer = esri;
    activeBasemap.addTo(map);

    let swapScheduled = false;
    const fallbackOnce = () => {
      if (swapScheduled) return;
      swapScheduled = true;
      map.removeLayer(activeBasemap);
      activeBasemap = carto;
      carto.addTo(map);
      map.invalidateSize();
    };
    esri.once("tileerror", fallbackOnce);

    const mcg = L.markerClusterGroup({ chunkedLoading: true });
    map.addLayer(mcg);
    mapRef.current = map;
    clusterRef.current = mcg;

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(mapDivRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const mcg = clusterRef.current;
    if (!map || !mcg) return;

    mcg.clearLayers();

    const withCoords = points.filter((p) => p.lat != null && p.lon != null);
    if (withCoords.length === 0) {
      map.setView({ lat: 56.4884, lng: 84.9481 } as LatLngExpression, 11);
      return;
    }

    withCoords.forEach((p) => {
      const hue = severityColor(p.severity);
      const marker = L.circleMarker([p.lat as number, p.lon as number], {
        radius: 12 + Math.min(14, p.frequency),
        stroke: true,
        color: "#0f172a",
        weight: 1,
        fillColor: hue,
        fillOpacity: 0.68,
      });
      const popupParts = [
        `<strong>${p.locationRaw}</strong>`,
        `Нормализованный адрес: ${p.normalizedAddress}`,
        `Жёсткость жалобы (1‑10): <strong>${p.severity}</strong>`,
        `Частота: <strong>${p.frequency}</strong>`,
        `Уверенность: ${Math.round((p.confidence ?? 0) * 100)}%`,
      ];
      if (p.summary) popupParts.push(`Кратко: ${p.summary}`);
      if (p.geocodeWarning) popupParts.push(`⚠️ ${p.geocodeWarning}`);
      marker.bindPopup(
        `<div style="font-size:13px;max-width:260px;line-height:1.35">${popupParts.join("<br/>")}</div>`,
      );
      mcg.addLayer(marker);
    });

    const bounds = L.latLngBounds(
      withCoords.map((p) => L.latLng(p.lat as number, p.lon as number)),
    );
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
  }, [points]);

  return (
    <div
      ref={mapDivRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: "420px",
        borderRadius: "12px",
        overflow: "hidden",
      }}
      aria-label="Карта проблемных участков"
    />
  );
}
