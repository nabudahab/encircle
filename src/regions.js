export const regions = [
  {
    id: "indiana",
    label: "Indiana",
    bounds: [[-88.10, 37.77], [-84.78, 41.77]],
    cameraBounds: [[-91.0, 36.2], [-81.9, 43.4]],
    areas: ["lafayette"],
  },
  {
    id: "illinois",
    label: "Illinois",
    bounds: [[-91.52, 36.97], [-87.49, 42.51]],
    cameraBounds: [[-96.0, 35.7], [-83.5, 43.8]],
    areas: ["champaign"],
  },
  {
    id: "indiana-illinois",
    label: "Indiana + Illinois",
    bounds: [[-91.52, 36.97], [-84.78, 42.51]],
    cameraBounds: [[-97.0, 34.9], [-79.0, 44.6]],
    areas: ["lafayette", "champaign"],
  },
];

export const demoAreas = {
  lafayette: { label: "West Lafayette, IN", center: [-86.9266, 40.4265], zoom: 11.45 },
  champaign: { label: "Champaign, IL", center: [-88.2441, 40.1110], zoom: 11.6 },
};
