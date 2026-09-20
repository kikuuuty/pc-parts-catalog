import { categories, models } from './model.js';
import { scalarField } from './search-fields.js';

const select = (id, label, unit = null) => ({ id, label, control: 'multi_select', target: 'filters', unit });
const range = (id, label, unit = null, step = 1) => ({ id, label, control: 'range', target: 'ranges', unit, step });
const facet = (id, label) => ({ ...select(id, label), target: 'facets' });
const boolean = (id, label, labels = { 0: '非対応', 1: '対応' }) => ({ ...select(id, label), optionLabels: labels });

// UI curation only: SQL types and columns always come from the search model.
// No product names, switch models, sensors or other high-cardinality identifiers.
const curated = {
  cpu: [select('family', 'ファミリー'), select('generation', '世代'), select('socket', 'ソケット'),
    range('core_count', 'コア数', 'コア'), range('thread_count', 'スレッド数'), range('boost_clock_ghz', 'ブーストクロック', 'GHz', 0.1),
    range('tdp_w', 'TDP', 'W'), boolean('includes_cooler', 'クーラー付属', { 0: 'なし', 1: 'あり' })],
  cpu_cooler: [boolean('water_cooled', '冷却方式', { 0: '空冷', 1: '水冷' }), range('radiator_size_mm', 'ラジエーターサイズ', 'mm'),
    range('height_mm', '高さ', 'mm'), range('fan_size_mm', 'ファンサイズ', 'mm')],
  memory: [select('ram_type', 'メモリ規格'), range('capacity_gb', '合計容量', 'GB'), range('module_capacity_gb', 'モジュール容量', 'GB'),
    range('speed', 'メモリ速度', 'MT/s'), range('kit_quantity', '枚数'), select('ecc', 'ECC'), boolean('xmp', 'XMP'), boolean('expo', 'EXPO')],
  motherboard: [select('socket', 'ソケット'), select('chipset', 'チップセット'), select('form_factor', 'フォームファクター'),
    select('ram_type', 'メモリ規格'), range('max_memory_gb', '最大メモリ容量', 'GB'), range('memory_slots', 'メモリスロット数'),
    range('m2_slots', 'M.2スロット数'), boolean('back_connect', '背面コネクター')],
  gpu: [select('chip_vendor', 'GPUメーカー'), select('chip_series', 'GPUシリーズ'), range('vram_gb', 'VRAM容量', 'GB'),
    select('memory_type', 'メモリ規格'), range('length_mm', '長さ', 'mm'), range('tdp_w', 'TDP', 'W')],
  storage: [select('storage_type', 'ストレージ種類'), select('form_factor', 'フォームファクター'), select('interface', 'インターフェース'),
    range('capacity_gb', '容量', 'GB'), range('pcie_generation', 'PCIe世代'), boolean('nvme', 'NVMe')],
  psu: [select('form_factor', 'フォームファクター'), select('efficiency_rating', '効率認証'), select('modular', 'ケーブル方式'),
    range('wattage', '電源容量', 'W'), range('length_mm', '奥行き', 'mm'), range('pcie_12vhpwr', '12VHPWRコネクター数')],
  case: [select('form_factor', 'フォームファクター'), range('max_gpu_length_mm', '最大GPU長', 'mm'),
    range('max_cpu_cooler_height_mm', '最大CPUクーラー高', 'mm'), range('max_psu_length_mm', '最大電源長', 'mm'),
    range('volume_l', '容積', 'L', 0.1), boolean('supports_back_connect', '背面コネクター対応')],
  case_fan: [range('size_mm', 'サイズ', 'mm'), select('connector', 'コネクター'), select('flow_direction', '風向き'),
    boolean('pwm', 'PWM'), range('quantity', '個数')],
  monitor: [range('screen_size_inches', '画面サイズ', 'インチ', 0.1), range('refresh_rate_hz', 'リフレッシュレート', 'Hz'),
    select('panel_type', 'パネル種類'), range('response_time_ms', '応答速度', 'ms', 0.1), select('hdr', 'HDR'),
    select('adaptive_sync', '可変リフレッシュレート'), select('aspect_ratio', 'アスペクト比'), facet('ports', '映像入力端子')],
  keyboard: [select('switch_type', 'スイッチ種類'), select('size', 'サイズ'), select('layout', '配列'), boolean('hot_swappable', 'ホットスワップ'),
    range('polling_rate_hz', 'ポーリングレート', 'Hz'), facet('connectivity', '接続方式'), facet('features', '機能')],
  mouse: [select('shape', '形状'), select('size', 'サイズ'), range('weight_g', '重量', 'g', 0.1), range('max_dpi', '最大DPI', 'DPI'),
    range('polling_rate_hz', 'ポーリングレート', 'Hz'), facet('connectivity', '接続方式'), facet('grip_types', '持ち方')],
  headphones: [select('headphone_type', 'ヘッドホン種類'), select('ear_cup_type', 'イヤーカップ種類'), range('weight_g', '重量', 'g', 0.1),
    boolean('has_microphone', 'マイク搭載'), facet('connection_types', '接続方式'), facet('features', '機能'), facet('platforms', '対応プラットフォーム')],
  webcam: [select('resolution', '解像度'), range('frame_rate_fps', 'フレームレート', 'fps'), facet('connectivity_type', '接続方式')],
  microphone: [facet('connectivity_type', '接続方式'), facet('polar_pattern', '指向性'), facet('features', '機能')],
};
export const filterRegistry = Object.fromEntries(categories.map(category => [category, [select('manufacturer', 'メーカー'), ...(curated[category] ?? [])]]));

export function filterType(category, definition) {
  return definition.target === 'facets' ? 'TEXT' : scalarField(models[category], definition.id).type;
}

export function validateFilterRegistry(registry = filterRegistry) {
  if (Object.keys(registry).length !== categories.length || categories.some(c => !Object.hasOwn(registry, c))) throw new Error('Filter categories must match models');
  for (const [category, definitions] of Object.entries(registry)) {
    const seen = new Set();
    for (const d of definitions) {
      if (seen.has(d.id) || typeof d.label !== 'string' || !d.label.trim() || !/^[a-z][a-z0-9_]*$/.test(d.id)) throw new Error(`Invalid filter: ${category}.${d.id}`);
      seen.add(d.id);
      if (!['filters', 'ranges', 'facets'].includes(d.target) || !['multi_select', 'range'].includes(d.control) ||
          (d.target === 'ranges') !== (d.control === 'range')) throw new Error(`Invalid target/control: ${d.id}`);
      if (d.target === 'facets') {
        if (!models[category].facets.includes(d.id)) throw new Error(`Unknown facet: ${d.id}`);
      } else if (!Object.hasOwn(models[category].fields, d.id) && d.id !== 'manufacturer') throw new Error(`Uncurated common field: ${d.id}`);
      const type = filterType(category, d);
      if (d.control === 'range' && (type === 'TEXT' || !Number.isFinite(d.step) || d.step <= 0 || type === 'INTEGER' && d.step !== 1)) throw new Error(`Invalid range: ${d.id}`);
      if (d.optionLabels && (d.control !== 'multi_select' || Object.values(d.optionLabels).some(v => typeof v !== 'string' || !v.trim()))) throw new Error(`Invalid option labels: ${d.id}`);
    }
  }
}
// Fail at startup, before any metadata can advertise an unusable search field.
validateFilterRegistry();
for (const definitions of Object.values(filterRegistry)) {
  for (const d of definitions) { if (d.optionLabels) Object.freeze(d.optionLabels); Object.freeze(d); }
  Object.freeze(definitions);
}
Object.freeze(filterRegistry);
