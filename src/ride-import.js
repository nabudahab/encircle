function childText(element, name) {
  return [...element.children].find((child) => child.localName === name)?.textContent.trim();
}

export async function readGpx(file) {
  if (file.size > 25_000_000) throw new Error("GPX files must be smaller than 25 MB.");
  const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
  if (xml.documentElement.localName !== "gpx") throw new Error("Choose a valid GPX file.");
  const tracks = [...xml.getElementsByTagNameNS("*", "trkseg")];
  const segments = [];
  let startedAt;

  for (const track of tracks) {
    let points = [];
    let previousTime;
    for (const point of track.getElementsByTagNameNS("*", "trkpt")) {
      const longitude = Number(point.getAttribute("lon") ?? NaN);
      const latitude = Number(point.getAttribute("lat") ?? NaN);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
        throw new Error("The GPX contains an invalid coordinate.");
      }
      const time = childText(point, "time");
      if (!startedAt && time) startedAt = time;
      const timestamp = Date.parse(time);
      if (timestamp - previousTime > 300_000) {
        if (points.length > 1) segments.push(points);
        points = [];
      }
      points.push([longitude, latitude]);
      previousTime = timestamp;
    }
    if (points.length > 1) segments.push(points);
  }

  const metadata = [...xml.documentElement.children].find((element) => element.localName === "metadata");
  startedAt ??= metadata && childText(metadata, "time");
  if (!startedAt || !/(?:Z|[+-]\d\d:\d\d)$/i.test(startedAt) || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error("The GPX needs a dated track or metadata timestamp with its time zone.");
  }
  if (!segments.length) throw new Error("This GPX does not contain a recorded track.");
  return { startedAt: new Date(startedAt).toISOString(), segments };
}

export async function requestGame(path, options) {
  const response = await fetch(`/api/${path}`, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error ?? "Check that the local Encircle server is running, then try again.");
  }
  return data;
}
