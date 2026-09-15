import { legacyNormalizers } from './normalizers/legacy.js';
import { extendedModels } from './extended-models.js';

// Application search model, NOT a replacement for the upstream JSON Schemas.
// Index declarations describe the frozen initial migration; later tuning is in 0003.
export const NORMALIZER_VERSION = 1;
const fields = (text = '', real = '', integer = '') => Object.fromEntries([
  ...text.split(' ').filter(Boolean).map(k => [k, 'TEXT']),
  ...real.split(' ').filter(Boolean).map(k => [k, 'REAL']),
  ...integer.split(' ').filter(Boolean).map(k => [k, 'INTEGER']),
]);
export const models = {
  cpu: {
    upstream: 'CPU', label: 'CPU', table: 'cpu',
    fields: fields('manufacturer family generation socket microarchitecture core_family', 'base_clock_ghz boost_clock_ghz tdp_w ppt_w max_memory_gb', 'core_count thread_count performance_cores efficiency_cores includes_cooler'),
    indexes: { cpu_family_cores: ['manufacturer', 'family', 'core_count', 'product_id'], cpu_socket: ['socket', 'product_id'] },
  },
  memory: {
    upstream: 'RAM', label: 'MEM', table: 'memory',
    fields: fields('ram_type form_factor ecc registered', 'capacity_gb module_capacity_gb speed cas_latency height_mm voltage', 'kit_quantity xmp expo'),
    indexes: { memory_type_speed: ['ram_type', 'speed', 'capacity_gb', 'product_id'] },
  },
  motherboard: {
    upstream: 'Motherboard', label: 'M/B', table: 'motherboard',
    fields: fields('socket chipset form_factor ram_type', 'max_memory_gb', 'memory_slots m2_slots sata_ports back_connect'),
    indexes: { motherboard_socket_memory: ['socket', 'ram_type', 'form_factor', 'product_id'] },
  },
  gpu: {
    upstream: 'GPU', label: 'GPU', table: 'gpu',
    fields: fields('chip_vendor chipset chip_series memory_type interface', 'vram_gb length_mm tdp_w boost_clock_mhz slot_width pcie_generation', 'pcie_lanes pcie_6_pin pcie_8_pin pcie_12vhpwr pcie_12v_2x6'),
    indexes: { gpu_vendor_vram: ['chip_vendor', 'vram_gb', 'length_mm', 'product_id'], gpu_length: ['length_mm', 'product_id'], gpu_series_vram: ['chip_vendor', 'chip_series', 'vram_gb', 'product_id'] },
  },
  storage: {
    upstream: 'Storage', label: 'Storage', table: 'storage',
    fields: fields('storage_type form_factor interface', 'capacity_gb pcie_generation cache_mb', 'pcie_lanes nvme'),
    indexes: { storage_capacity: ['capacity_gb', 'product_id'], storage_type_capacity: ['storage_type', 'capacity_gb', 'product_id'] },
  },
  psu: {
    upstream: 'PSU', label: 'PSU', table: 'psu',
    fields: fields('form_factor efficiency_rating modular', 'wattage length_mm', 'atx_24_pin eps_8_pin pcie_12vhpwr pcie_6_plus_2_pin'),
    indexes: { psu_form_wattage: ['form_factor', 'wattage', 'product_id'], psu_wattage: ['wattage', 'product_id'] },
  },
  case: {
    upstream: 'PCCase', label: 'Case', table: 'pc_case',
    fields: fields('form_factor', 'max_gpu_length_mm max_cpu_cooler_height_mm max_psu_length_mm depth_mm width_mm height_mm volume_l', 'expansion_slots supports_back_connect'),
    indexes: { case_gpu_clearance: ['max_gpu_length_mm', 'product_id'] },
  },
  case_fan: {
    upstream: 'CaseFan', label: 'Case Fan', table: 'case_fan',
    fields: fields('connector flow_direction', 'size_mm airflow_min_cfm airflow_max_cfm noise_min_db noise_max_db static_pressure_mmh2o', 'quantity pwm'),
    indexes: { fan_size_airflow: ['size_mm', 'airflow_max_cfm', 'product_id'] },
  },
  cpu_cooler: {
    upstream: 'CPUCooler', label: 'CPU Cooler', table: 'cpu_cooler',
    fields: fields('', 'height_mm radiator_size_mm noise_min_db noise_max_db fan_size_mm rpm_min rpm_max', 'water_cooled fan_quantity'),
    indexes: { cooler_type_height: ['water_cooled', 'height_mm', 'product_id'], cooler_radiator: ['radiator_size_mm', 'product_id'] },
  },
};
// Freeze the historical migration cohort, independent of future registrations.
export const initialCategories = Object.keys(models);
export const legacyFacets = ['memory_type', 'socket', 'motherboard_form_factor', 'psu_form_factor'];
for (const [category, model] of Object.entries(models)) Object.assign(model, {
  normalizer: legacyNormalizers[category], facets: legacyFacets,
  searchFields: ['family', 'generation', 'chipset', 'chip_series'], searchIndex: 'product_fts',
});
Object.assign(models, extendedModels);
export const categories = Object.keys(models);
export const upstreamCategories = Object.fromEntries(Object.entries(models).map(([k, v]) => [v.upstream, k]));
