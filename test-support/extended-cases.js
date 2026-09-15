// Only structured upstream fields; the common identity fixture is shared.
export const extendedCases = {
  headphones: {
    data: { headphone_type: 'Closed-Back', ear_cup_type: 'Over-Ear', driver_size: 50, weight: 250, battery_life: 0, has_microphone: false,
      connection_types: ['USB-C', 'Bluetooth'], features: ['ANC'], platforms: ['PC', 'Mobile'] },
    spec: { headphone_type: 'Closed-Back', ear_cup_type: 'Over-Ear', driver_size_mm: 50, weight_g: 250, battery_life_hours: 0, has_microphone: 0 },
  },
  keyboard: {
    data: { switch: 'Cherry MX Red', switch_type: 'Linear', size: '75%', layout: 'ANSI', hot_swappable: false, polling_rate: 1000, battery_capacity: 0,
      connectivity: ['Wired USB-A', 'Bluetooth', 'Bluetooth'], features: ['Knob', 'Split'] },
    spec: { switch_model: 'Cherry MX Red', switch_type: 'Linear', size: '75%', layout: 'ANSI', hot_swappable: 0, polling_rate_hz: 1000, battery_capacity_mah: 0 },
  },
  microphone: { data: { connectivity_type: ['USB-C', 'XLR'], polar_pattern: ['Cardioid', 'Bidirectional'], features: ['Mute Button'] }, spec: {} },
  monitor: {
    data: { screen_size: 27, resolution: { horizontalRes: 2560, verticalRes: 1440 }, refresh_rate: 165, panel_type: 'IPS', response_time: 0,
      hdr: 'HDR400', max_brightness: 400, adaptive_sync: 'FreeSync', aspect_ratio: '16:9', video_outputs: { hdmi_2_1: 2, usb_c: 1, vga: 0, unknown_port: 2 } },
    spec: { screen_size_inches: 27, resolution_width: 2560, resolution_height: 1440, refresh_rate_hz: 165, panel_type: 'IPS', response_time_ms: 0,
      hdr: 'HDR400', brightness_nits: 400, adaptive_sync: 'FreeSync', aspect_ratio: '16:9' },
  },
  mouse: {
    data: { shape: 'Ergonomic', size: 'Medium', sensor: 'PixArt PAW3395', weight: 55, max_dpi: 26000, polling_rate: 4000, buttons: 5, battery_life: 0,
      dimensions: { length: 120, width: 60, height: 40 }, connectivity: ['Wired USB-C', 'Wireless 2.4GHz'], grip_types: ['Palm', 'Claw'] },
    spec: { shape: 'Ergonomic', size: 'Medium', sensor: 'PixArt PAW3395', weight_g: 55, max_dpi: 26000, polling_rate_hz: 4000, buttons: 5,
      battery_life_hours: 0, length_mm: 120, width_mm: 60, height_mm: 40 },
  },
  webcam: { data: { resolution: '4k', frame_rate: '120fps', connectivity_type: ['Wired USB-C', 'Bluetooth'] }, spec: { resolution: '4k', frame_rate_fps: 120 } },
};
