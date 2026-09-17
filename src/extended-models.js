import { text, number, positive, integer, bool } from './normalizers/legacy.js';

// Small, explicit scalar mappings: [upstream field, SQL type, conversion].
// Arrays have their own facet mapping; unknown/unselected fields stay in raw.
const t = source => [source, 'TEXT', text];
const n = source => [source, 'REAL', number];
const p = source => [source, 'REAL', positive];
const i = source => [source, 'INTEGER', integer];
const b = source => [source, 'INTEGER', bool];
const valueAt = (data, source) => source.split('.').reduce((v, key) => v?.[key], data);
function define(upstream, label, table, scalars = {}, arrays = {}, indexes = {}, extra) {
  return {
    upstream, label, table, fields: Object.fromEntries(Object.entries(scalars).map(([key, [, type]]) => [key, type])),
    indexes, facets: Object.keys(arrays), searchFields: [],
    // Retain the source mappings for schema conformance checks and documentation.
    scalarSources: Object.fromEntries(Object.entries(scalars).map(([key, [source]]) => [key, source])),
    facetSources: arrays,
    normalizer(data, spec, facet) {
      for (const [key, [source, , convert]] of Object.entries(scalars)) spec[key] = convert(valueAt(data, source));
      for (const [attribute, source] of Object.entries(arrays)) facet(attribute, valueAt(data, source));
      extra?.(data, spec, facet);
    },
  };
}

// Source: schemas/*.schema.json at eec0df175504ebd15f0f3e3a8249a18a22f00940.
// Empty scalar sets are intentional: these schemas do not describe useful specs.
export const extendedModels = {
  accessory: define('Accessory', 'Accessory', 'accessory'),
  capture_card: define('CaptureCard', 'Capture Card', 'capture_card'),
  chair: define('Chair', 'Chair', 'chair'),
  desk: define('Desk', 'Desk', 'desk'),
  headphones: define('Headphones', 'Headphones', 'headphones', {
    headphone_type: t('headphone_type'), ear_cup_type: t('ear_cup_type'),
    driver_size_mm: p('driver_size'), weight_g: p('weight'), battery_life_hours: n('battery_life'),
    has_microphone: b('has_microphone'),
  }, { connection_types: 'connection_types', features: 'features', platforms: 'platforms' }, {
    headphones_type_weight: ['headphone_type', 'weight_g', 'product_id'],
  }),
  keyboard: define('Keyboard', 'Keyboard', 'keyboard', {
    switch_model: t('switch'), switch_type: t('switch_type'), size: t('size'), layout: t('layout'),
    hot_swappable: b('hot_swappable'), polling_rate_hz: p('polling_rate'), battery_capacity_mah: n('battery_capacity'),
  }, { connectivity: 'connectivity', features: 'features' }, {
    keyboard_size_switch: ['size', 'switch_type', 'product_id'],
    keyboard_polling: ['polling_rate_hz', 'product_id'],
  }),
  laptop: define('Laptop', 'Laptop', 'laptop'),
  lighting: define('Lighting', 'Lighting', 'lighting'),
  microphone: define('Microphone', 'Microphone', 'microphone', {}, {
    connectivity_type: 'connectivity_type', polar_pattern: 'polar_pattern', features: 'features',
  }),
  monitor: define('Monitor', 'Monitor', 'monitor', {
    screen_size_inches: p('screen_size'), resolution_width: i('resolution.horizontalRes'), resolution_height: i('resolution.verticalRes'),
    refresh_rate_hz: p('refresh_rate'), panel_type: t('panel_type'), response_time_ms: n('response_time'),
    hdr: t('hdr'), brightness_nits: p('max_brightness'), adaptive_sync: t('adaptive_sync'), aspect_ratio: t('aspect_ratio'),
  }, {}, {
    monitor_resolution_refresh: ['resolution_width', 'resolution_height', 'refresh_rate_hz', 'product_id'],
    monitor_size: ['screen_size_inches', 'product_id'],
  }, (data, spec, facet) => {
    // Presence is a facet; exact version-specific port counts remain in raw.
    facet('ports', Object.entries(data.video_outputs ?? {}).filter(([key, count]) => monitorPorts.includes(key) && positive(count)).map(([key]) => key));
  }),
  mouse: define('Mouse', 'Mouse', 'mouse', {
    shape: t('shape'), size: t('size'), sensor: t('sensor'), weight_g: p('weight'), max_dpi: p('max_dpi'),
    polling_rate_hz: p('polling_rate'), buttons: i('buttons'), battery_life_hours: n('battery_life'),
    length_mm: p('dimensions.length'), width_mm: p('dimensions.width'), height_mm: p('dimensions.height'),
  }, { connectivity: 'connectivity', grip_types: 'grip_types' }, {
    mouse_shape_weight: ['shape', 'weight_g', 'product_id'], mouse_polling: ['polling_rate_hz', 'product_id'],
  }),
  mousepad: define('Mousepad', 'Mousepad', 'mousepad'),
  network_card: define('NetworkCard', 'Network Card', 'network_card'),
  os: define('OS', 'Operating System', 'os'),
  prebuilt_desktop: define('PrebuiltDesktop', 'Prebuilt Desktop', 'prebuilt_desktop'),
  sound_card: define('SoundCard', 'Sound Card', 'sound_card'),
  speaker: define('Speaker', 'Speaker', 'speaker'),
  stand: define('Stand', 'Stand', 'stand'),
  thermal_compound: define('ThermalCompound', 'Thermal Compound', 'thermal_compound'),
  vr_headset: define('VRHeadset', 'VR Headset', 'vr_headset'),
  webcam: define('Webcam', 'Webcam', 'webcam', {
    resolution: t('resolution'),
    frame_rate_fps: ['frame_rate', 'INTEGER', value => ({ '24fps': 24, '30fps': 30, '60fps': 60, '90fps': 90, '120fps': 120 })[value] ?? null],
  }, { connectivity_type: 'connectivity_type' }, {
    webcam_resolution_fps: ['resolution', 'frame_rate_fps', 'product_id'],
  }),
};
export const monitorPorts = ['hdmi_2_2', 'hdmi_2_1', 'hdmi_2_1a', 'hdmi_2_1b', 'hdmi_2_0', 'hdmi_2_0a', 'hdmi_2_0b',
  'displayport_2_1', 'displayport_2_1a', 'displayport_1_4a', 'displayport_2_1_b', 'usb_c', 'dvi_d', 'vga'];
extendedModels.monitor.facets.push('ports');
