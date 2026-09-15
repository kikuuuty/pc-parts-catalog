// Established normalization rules for the original nine categories. Keep their
// values and ordering stable: NORMALIZER_VERSION=1 hashes must not change.
export const text = v => typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null;
export const identifierKey = v => v.normalize('NFKC').trim().replace(/[a-z]/g, c => c.toUpperCase());
export const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const positive = v => number(v) > 0 ? v : null;
export const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
export const bool = v => typeof v === 'boolean' ? Number(v) : null;
export const socket = v => text(v)?.replace(/^LGA\s*(\d)/i, 'LGA $1') ?? null;
export function manufacturer(v) {
  const s = text(v);
  return ({ intel: 'Intel', amd: 'AMD', nvidia: 'NVIDIA', asus: 'ASUS', msi: 'MSI', gigabyte: 'Gigabyte', corsair: 'Corsair', 'g.skill': 'G.Skill', teamgroup: 'TEAMGROUP', silverstone: 'SilverStone' })[s?.toLowerCase()] ?? s;
}
export function cpuClass(d) {
  for (const value of [d.series, d.metadata?.series, d.metadata?.name]) {
    const s = text(value)?.replace(/[®™]/g, '') ?? '';
    const match = s.match(/\b(Core\s+Ultra\s+[3579]|Core\s+i[3579]|Ryzen\s+[3579])\b/i);
    if (match) {
      const family = match[1].replace(/\s+/g, ' ').toLowerCase().replace(/^core ultra/, 'Core Ultra').replace(/^core/, 'Core').replace(/^ryzen/, 'Ryzen');
      // Only a whole family bucket supplies generation, never a full SKU/name.
      const bucket = s.slice(match.index).match(/^(?:Core\s+Ultra\s+[3579]|Core\s+i[3579]|Ryzen\s+[3579])\s+(\d{3,5})$/i);
      return { family, generation: bucket?.[1] ?? null };
    }
  }
  return { family: null, generation: null };
}
export function gpuSeries(v) {
  const s = text(v) ?? '';
  let m = s.match(/\bGeForce\s+(RTX|GTX)\s+(\d{2})\d{2}\b/i);
  if (m) return `GeForce ${m[1].toUpperCase()} ${m[2]}`;
  m = s.match(/\bRadeon\s+RX\s+([5-9])\d{3}\b/i);
  if (m) return `Radeon RX ${m[1]}000`;
  m = s.match(/\bArc\s+([AB])\d{3}\b/i);
  return m ? `Arc ${m[1].toUpperCase()}` : null;
}
export function pcie(v) {
  const s = text(v) ?? '';
  return {
    pcie_generation: s.match(/\bPCIe\s+(\d+(?:\.\d+)?)\b/i)?.[1] ? Number(s.match(/\bPCIe\s+(\d+(?:\.\d+)?)\b/i)[1]) : null,
    pcie_lanes: /\bPCIe\b/i.test(s) && s.match(/\bx(\d+)\b/i) ? Number(s.match(/\bx(\d+)\b/i)[1]) : null,
  };
}
export const legacyNormalizers = {
    cpu(d, spec, facet) {
      const m = d.metadata;
      Object.assign(spec, cpuClass(d), { manufacturer: manufacturer(m.manufacturer), socket: socket(d.socket), microarchitecture: text(d.microarchitecture), core_family: text(d.coreFamily), core_count: positive(integer(d.cores?.total)), thread_count: positive(integer(d.cores?.threads)), performance_cores: integer(d.cores?.performance), efficiency_cores: integer(d.cores?.efficiency), base_clock_ghz: positive(d.clocks?.performance?.base), boost_clock_ghz: positive(d.clocks?.performance?.boost), tdp_w: positive(d.specifications?.tdp), ppt_w: positive(d.specifications?.ppt), max_memory_gb: positive(d.specifications?.memory?.maxSupport), includes_cooler: bool(d.specifications?.includesCooler) });
      facet('memory_type', d.specifications?.memory?.types);
    },
    memory(d, spec) {
      Object.assign(spec, { ram_type: text(d.ram_type), form_factor: text(d.form_factor), ecc: text(d.ecc), registered: text(d.registered), capacity_gb: positive(d.capacity) ?? positive(d.modules?.capacity_gb * d.modules?.quantity), module_capacity_gb: positive(d.modules?.capacity_gb), speed: positive(d.speed), cas_latency: positive(d.cas_latency), height_mm: positive(d.height), voltage: positive(d.voltage), kit_quantity: positive(integer(d.modules?.quantity)), xmp: Array.isArray(d.profile_support) ? Number(d.profile_support.includes('XMP')) : null, expo: Array.isArray(d.profile_support) ? Number(d.profile_support.includes('EXPO')) : null });
    },
    motherboard(d, spec) {
      Object.assign(spec, { socket: socket(d.socket), chipset: text(d.chipset), form_factor: text(d.form_factor), ram_type: text(d.memory?.ram_type), max_memory_gb: positive(d.memory?.max), memory_slots: integer(d.memory?.slots), m2_slots: Array.isArray(d.m2_slots) ? d.m2_slots.length : null, sata_ports: d.storage_devices?.sata_6_gb_s != null && d.storage_devices?.sata_3_gb_s != null ? integer(d.storage_devices.sata_6_gb_s + d.storage_devices.sata_3_gb_s) : null, back_connect: bool(d.back_connect_connectors) });
    },
    gpu(d, spec) {
      Object.assign(spec, pcie(d.interface), { chip_vendor: manufacturer(d.chipset_manufacturer), chipset: text(d.chipset), chip_series: gpuSeries(d.chipset), memory_type: text(d.memory_type), interface: text(d.interface), vram_gb: positive(d.memory), length_mm: positive(d.length), tdp_w: positive(d.tdp), boost_clock_mhz: positive(d.core_boost_clock), slot_width: positive(d.total_slot_width), pcie_6_pin: integer(d.power_connectors?.pcie_6_pin), pcie_8_pin: integer(d.power_connectors?.pcie_8_pin), pcie_12vhpwr: integer(d.power_connectors?.pcie_12VHPWR), pcie_12v_2x6: integer(d.power_connectors?.pcie_12V_2x6) });
    },
    storage(d, spec) {
      Object.assign(spec, pcie(d.interface), { storage_type: text(d.storage_type) ?? (['SSD','HDD','SSHD'].includes(d.type) ? d.type : null), form_factor: text(d.form_factor), interface: text(d.interface), capacity_gb: positive(d.capacity), cache_mb: number(d.cache), nvme: bool(d.nvme) });
    },
    psu(d, spec) {
      Object.assign(spec, { form_factor: text(d.form_factor), efficiency_rating: text(d.efficiency_rating), modular: text(d.modular), wattage: positive(d.wattage), length_mm: positive(d.length), ...Object.fromEntries(['atx_24_pin','eps_8_pin','pcie_12vhpwr','pcie_6_plus_2_pin'].map(k => [k, integer(d.connectors?.[k])])) });
    },
    case(d, spec, facet) {
      Object.assign(spec, { form_factor: text(d.form_factor), max_gpu_length_mm: positive(d.max_video_card_length), max_cpu_cooler_height_mm: positive(d.max_cpu_cooler_height), max_psu_length_mm: positive(d.max_psu_length), depth_mm: positive(d.dimensions_mm?.depth), width_mm: positive(d.dimensions_mm?.width), height_mm: positive(d.dimensions_mm?.height), volume_l: positive(d.volume), expansion_slots: integer(d.expansion_slots), supports_back_connect: bool(d.supports_rear_connecting_motherboard) });
      facet('motherboard_form_factor', d.supported_motherboard_form_factors);
      facet('psu_form_factor', d.supported_power_supply_form_factors);
    },
    case_fan(d, spec) {
      Object.assign(spec, { size_mm: positive(d.size), quantity: positive(integer(d.quantity)), airflow_min_cfm: number(d.min_airflow), airflow_max_cfm: number(d.max_airflow) ?? number(d.min_airflow), noise_min_db: number(d.min_noise_level), noise_max_db: number(d.max_noise_level) ?? number(d.min_noise_level), pwm: bool(d.pwm), connector: text(d.connector), flow_direction: text(d.flow_direction), static_pressure_mmh2o: number(d.static_pressure) });
    },
    cpu_cooler(d, spec, facet) {
      Object.assign(spec, { height_mm: positive(d.height), radiator_size_mm: positive(d.radiator_size), water_cooled: bool(d.water_cooled), noise_min_db: number(d.min_noise_level), noise_max_db: number(d.max_noise_level) ?? number(d.min_noise_level), fan_size_mm: positive(d.fan_size), fan_quantity: integer(d.fan_quantity), rpm_min: number(d.min_fan_rpm), rpm_max: number(d.max_fan_rpm) ?? number(d.min_fan_rpm) });
      facet('socket', d.cpu_sockets, socket);
    },
};
