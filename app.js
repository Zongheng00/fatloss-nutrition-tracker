const STORAGE_KEY = "fatloss_app_v1";
const APP_VERSION = "v29";
const ADD_NEW_FOOD_OPTION_VALUE = "__add_new_food__";
const NUTRIENT_NAME_MAP = {
  热量: "Calories",
  蛋白质: "Protein",
  脂肪: "Fat",
  碳水化合物: "Carbs"
};

function toCanonicalNutrientName(name) {
  return NUTRIENT_NAME_MAP[name] || name;
}

function remapNutrientValueMap(map) {
  const src = map && typeof map === "object" ? map : {};
  const out = {};
  Object.entries(src).forEach(([key, value]) => {
    const targetKey = toCanonicalNutrientName(key);
    const prev = Number(out[targetKey] || 0);
    const next = Number(value || 0);
    out[targetKey] = Number((prev + next).toFixed(4));
  });
  return out;
}

function migrateNutrientNames(parsed) {
  parsed.nutrients = (parsed.nutrients || []).map((n) => ({ ...n, name: toCanonicalNutrientName(n.name) }));

  // 去重，避免同时出现中文和英文同义字段
  const seen = new Set();
  parsed.nutrients = parsed.nutrients.filter((n) => {
    if (seen.has(n.name)) return false;
    seen.add(n.name);
    return true;
  });

  parsed.defaultGoals = remapNutrientValueMap(parsed.defaultGoals);
  parsed.intakeByDate = Object.fromEntries(
    Object.entries(parsed.intakeByDate || {}).map(([date, totals]) => [date, remapNutrientValueMap(totals)])
  );

  Object.values(parsed.intakeLogsByDate || {}).forEach((logs) => {
    (logs || []).forEach((log) => {
      if (!log || !log.nutrients) return;
      log.nutrients = remapNutrientValueMap(log.nutrients);
    });
  });

  (parsed.foods || []).forEach((food) => {
    food.nutrients = remapNutrientValueMap(food.nutrients);
  });
}

class AppStore {
  constructor() {
    this.state = this.load();
  }

  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.defaultGoals) {
        const today = new Date().toISOString().slice(0, 10);
        const fromToday = parsed.goalsByDate?.[today];
        const fromAnyDate = Object.values(parsed.goalsByDate || {})[0] || {};
        parsed.defaultGoals = { ...fromAnyDate, ...fromToday };
      }
      parsed.nutrients = parsed.nutrients || [
        { name: "Calories", unit: "kcal" },
        { name: "Protein", unit: "g" },
        { name: "Fat", unit: "g" },
        { name: "Carbs", unit: "g" }
      ];
      parsed.intakeByDate = parsed.intakeByDate || {};
      parsed.intakeLogsByDate = parsed.intakeLogsByDate || {};
      parsed.foods = parsed.foods || [];
      parsed.llm = parsed.llm || { endpoint: "https://api.openai.com", model: "gpt-4o-mini", token: "" };
      parsed.defaultGoals = parsed.defaultGoals || {};
      migrateNutrientNames(parsed);
      parsed.nutrients.forEach((n) => {
        if (parsed.defaultGoals[n.name] == null) parsed.defaultGoals[n.name] = 0;
      });
      // 把老的食物日志补上 foodId/amount，便于后续和模板联动
      Object.values(parsed.intakeLogsByDate || {}).forEach((logs) => {
        (logs || []).forEach((log) => {
          if (!log) return;
          const source = String(log.source || "").trim();
          const candidate = log.foodName || parseFoodNameFromSource(source);
          const matched = (parsed.foods || []).find(
            (f) => normalizeFoodName(f.name) === normalizeFoodName(candidate) || source.startsWith(`${f.name} `) || source === f.name
          );
          if (!matched) return;
          log.type = "food";
          log.foodId = matched.id;
          log.foodName = matched.name;
          log.amount = parseAmountFromSource(source, log.amount || matched.baseAmount);
        });
      });
      // 兼容旧版本：把按天汇总迁移为可删除的日志记录
      Object.entries(parsed.intakeByDate || {}).forEach(([date, totals]) => {
        const hasLog = Array.isArray(parsed.intakeLogsByDate[date]) && parsed.intakeLogsByDate[date].length > 0;
        const hasTotal = Object.values(totals || {}).some((v) => Number(v || 0) !== 0);
        if (!hasLog && hasTotal) {
          parsed.intakeLogsByDate[date] = [
            {
              id: `legacy_${date}`,
              type: "legacy",
              source: "Migrated legacy daily totals",
              createdAt: new Date().toISOString(),
              nutrients: totals
            }
          ];
        }
      });
      return parsed;
    }
    return {
      nutrients: [
        { name: "Calories", unit: "kcal" },
        { name: "Protein", unit: "g" },
        { name: "Fat", unit: "g" },
        { name: "Carbs", unit: "g" }
      ],
      defaultGoals: { Calories: 1600, Protein: 80, Fat: 50, Carbs: 180 },
      foods: [],
      intakeByDate: {},
      intakeLogsByDate: {},
      llm: { endpoint: "https://api.openai.com", model: "gpt-4o-mini", token: "" }
    };
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }
}

class Food {
  constructor({ id, name, baseAmount, baseUnit, nutrients }) {
    this.id = id;
    this.name = name;
    this.baseAmount = Number(baseAmount);
    this.baseUnit = baseUnit;
    this.nutrients = nutrients;
  }

  intakeFor(amount) {
    const ratio = Number(amount) / this.baseAmount;
    const output = {};
    Object.entries(this.nutrients).forEach(([k, v]) => {
      output[k] = Number((Number(v) * ratio).toFixed(4));
    });
    return output;
  }
}

class RecommendationEngine {
  static remaining(goals, intake) {
    const out = {};
    const keys = new Set([...Object.keys(goals || {}), ...Object.keys(intake || {})]);
    keys.forEach((k) => {
      out[k] = Number(((goals?.[k] || 0) - (intake?.[k] || 0)).toFixed(4));
    });
    return out;
  }

  // 简单可解释的贪心组合：每轮选择最能覆盖缺口的食物
  static suggestFoods(foods, deficits, maxItems = 3) {
    const picks = [];
    const remain = { ...deficits };
    const positiveKeys = Object.keys(remain).filter((k) => remain[k] > 0);
    if (!positiveKeys.length || !foods.length) return { picks, remain };

    for (let i = 0; i < maxItems; i += 1) {
      let best = null;
      let bestScore = -1;

      foods.forEach((foodRaw) => {
        const food = new Food(foodRaw);
        const nutrients = food.intakeFor(food.baseAmount);
        let score = 0;
        positiveKeys.forEach((k) => {
          const need = Math.max(remain[k] || 0, 0);
          const got = Math.max(nutrients[k] || 0, 0);
          score += Math.min(need, got);
        });
        if (score > bestScore) {
          bestScore = score;
          best = foodRaw;
        }
      });

      if (!best || bestScore <= 0) break;
      picks.push({ foodId: best.id, amount: best.baseAmount, unit: best.baseUnit });
      const food = new Food(best);
      const delta = food.intakeFor(best.baseAmount);
      Object.keys(remain).forEach((k) => {
        remain[k] = Number(((remain[k] || 0) - (delta[k] || 0)).toFixed(4));
      });
    }

    return { picks, remain };
  }
}

const store = new AppStore();
const $ = (id) => document.getElementById(id);

const state = {
  activeDate: new Date().toISOString().slice(0, 10),
  lastOcrParsed: {},
  editingFoodId: null,
  editingIntakeLogId: null,
  lastSelectedFoodId: "",
  foodSearchKeyword: ""
};

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeFoodName(name) {
  return String(name || "").trim().toLowerCase();
}

function hasFoodNameConflict(name, excludeId = null) {
  const normalized = normalizeFoodName(name);
  if (!normalized) return false;
  return store.state.foods.some((f) => normalizeFoodName(f.name) === normalized && f.id !== excludeId);
}

function filterFoodsByKeyword(keyword) {
  const normalizedKeyword = normalizeFoodName(keyword);
  if (!normalizedKeyword) return [...store.state.foods];
  return store.state.foods.filter((f) => normalizeFoodName(f.name).includes(normalizedKeyword));
}

function parseFoodNameFromSource(source) {
  const text = String(source || "").trim();
  const m = text.match(/^(.+?)\s+\d+(?:\.\d+)?/);
  return m ? m[1].trim() : text;
}

function parseAmountFromSource(source, fallbackAmount = 0) {
  const text = String(source || "");
  const m = text.match(/(\d+(?:\.\d+)?)/);
  const parsed = Number(m?.[1]);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fallback = Number(fallbackAmount);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function resolveFoodForLog(log) {
  if (!log) return null;
  if (log.foodId) {
    const byId = store.state.foods.find((f) => f.id === log.foodId);
    if (byId) return byId;
  }
  const candidateName = log.foodName || parseFoodNameFromSource(log.source);
  if (!candidateName) return null;
  const byName = store.state.foods.find((f) => normalizeFoodName(f.name) === normalizeFoodName(candidateName));
  return byName || null;
}

function relinkFoodLogsByFood(food) {
  Object.values(store.state.intakeLogsByDate || {}).forEach((logs) => {
    (logs || []).forEach((log) => {
      const candidateName = log.foodName || parseFoodNameFromSource(log.source);
      if (normalizeFoodName(candidateName) !== normalizeFoodName(food.name)) return;
      log.type = "food";
      log.foodId = food.id;
      log.foodName = food.name;
      if (!Number.isFinite(Number(log.amount)) || Number(log.amount) <= 0) {
        log.amount = parseAmountFromSource(log.source, food.baseAmount);
      }
    });
  });
}

function relinkAllFoodLogs() {
  Object.values(store.state.intakeLogsByDate || {}).forEach((logs) => {
    (logs || []).forEach((log) => {
      const food = resolveFoodForLog(log);
      if (!food) return;
      log.type = "food";
      log.foodId = food.id;
      log.foodName = food.name;
      if (!Number.isFinite(Number(log.amount)) || Number(log.amount) <= 0) {
        log.amount = parseAmountFromSource(log.source, food.baseAmount);
      }
    });
  });
}

function ensureDateSlots(date) {
  if (!store.state.intakeByDate[date]) {
    store.state.intakeByDate[date] = {};
  }
  if (!Array.isArray(store.state.intakeLogsByDate[date])) {
    store.state.intakeLogsByDate[date] = [];
  }
}

function setFoodManagerVisible(show) {
  const modal = $("food-modal");
  if (!modal) return;
  modal.classList.toggle("hidden", !show);
  modal.setAttribute("aria-hidden", show ? "false" : "true");
  document.body.style.overflow = show ? "hidden" : "";
}

function setFoodModalTab(tab) {
  const manualPanel = $("food-panel-manual");
  const ocrPanel = $("food-panel-ocr");
  const manualBtn = $("food-tab-manual");
  const ocrBtn = $("food-tab-ocr");
  const isManual = tab !== "ocr";
  manualPanel.classList.toggle("hidden", !isManual);
  ocrPanel.classList.toggle("hidden", isManual);
  manualBtn.classList.toggle("btn-secondary", !isManual);
  ocrBtn.classList.toggle("btn-secondary", isManual);
}

function syncFoodFormMode() {
  const isEditing = Boolean(state.editingFoodId);
  const modeTip = $("food-form-mode");
  const submitBtn = $("food-form-submit");
  const cancelBtn = $("food-cancel-edit");
  if (modeTip) modeTip.textContent = isEditing ? "Mode: Edit Template" : "Mode: New Template";
  if (submitBtn) submitBtn.textContent = isEditing ? "Save Changes" : "Save Food Template";
  if (cancelBtn) cancelBtn.classList.toggle("hidden", !isEditing);
}

function resetFoodForm() {
  const form = $("food-form");
  if (!form) return;
  form.reset();
  $("food-serving-amount").value = "";
  $("food-serving-unit").value = "g";
  document.querySelectorAll('[data-prefix="food"]').forEach((el) => {
    el.value = "";
  });
}

function enterFoodEdit(id) {
  const food = store.state.foods.find((f) => f.id === id);
  if (!food) return;
  state.editingFoodId = id;
  setFoodManagerVisible(true);
  setFoodModalTab("manual");
  $("food-name").value = food.name;
  $("food-serving-amount").value = food.baseAmount;
  $("food-serving-unit").value = food.baseUnit;
  document.querySelectorAll('[data-prefix="food"]').forEach((el) => {
    el.value = food.nutrients[el.dataset.name] ?? 0;
  });
  syncFoodFormMode();
}

function exitFoodEdit() {
  state.editingFoodId = null;
  resetFoodForm();
  syncFoodFormMode();
}

function setIntakeEditVisible(show) {
  const panel = $("intake-edit-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !show);
}

function setIntakeEditMode(log) {
  const resolvedFood = resolveFoodForLog(log);
  const isFoodLog = Boolean(resolvedFood);
  const foodFields = $("intake-edit-food-fields");
  const sourceInput = $("intake-edit-source");
  const foodNameInput = $("intake-edit-food-name");
  const foodAmountInput = $("intake-edit-food-amount");
  foodFields.classList.toggle("hidden", !isFoodLog);
  sourceInput.disabled = isFoodLog;
  document.querySelectorAll('[data-prefix="intake-edit"]').forEach((el) => {
    el.disabled = isFoodLog;
  });
  if (isFoodLog) {
    foodNameInput.value = `Linked template: ${resolvedFood.name}`;
    foodAmountInput.value = Number(log.amount || 0);
  } else {
    foodNameInput.value = "";
    foodAmountInput.value = "";
  }
}

function findIntakeLogById(date, id) {
  ensureDateSlots(date);
  return (store.state.intakeLogsByDate[date] || []).find((x) => x.id === id);
}

function enterIntakeEdit(id) {
  const log = findIntakeLogById(state.activeDate, id);
  if (!log) return;
  state.editingIntakeLogId = id;
  $("intake-edit-source").value = log.source || "";
  document.querySelectorAll('[data-prefix="intake-edit"]').forEach((el) => {
    el.value = log.nutrients?.[el.dataset.name] ?? 0;
  });
  setIntakeEditMode(log);
  setIntakeEditVisible(true);
}

function exitIntakeEdit() {
  state.editingIntakeLogId = null;
  $("intake-edit-source").disabled = false;
  document.querySelectorAll('[data-prefix="intake-edit"]').forEach((el) => {
    el.disabled = false;
  });
  $("intake-edit-food-fields").classList.add("hidden");
  setIntakeEditVisible(false);
}

function renderNutrients() {
  const container = $("nutrient-list");
  container.innerHTML = "";
  store.state.nutrients.forEach((n, idx) => {
    const row = document.createElement("div");
    row.className = "nutrient-row";
    row.innerHTML = `<span>${n.name}</span><span>${n.unit}</span><button data-idx="${idx}">Delete</button>`;
    row.querySelector("button").onclick = () => {
      if (["Calories", "Protein", "Fat", "Carbs", "热量", "蛋白质", "脂肪", "碳水化合物"].includes(n.name)) {
        alert("Default nutrients are not recommended to delete.");
        return;
      }
      store.state.nutrients.splice(idx, 1);
      delete store.state.defaultGoals[n.name];
      Object.values(store.state.intakeByDate).forEach((i) => delete i[n.name]);
      Object.values(store.state.intakeLogsByDate).forEach((logs) =>
        (logs || []).forEach((log) => delete log.nutrients?.[n.name])
      );
      store.state.foods.forEach((f) => delete f.nutrients[n.name]);
      store.save();
      rerenderAll();
    };
    container.appendChild(row);
  });
}

function renderGoalForm() {
  const goals = store.state.defaultGoals;
  const box = $("goal-form-container");
  box.innerHTML = "";

  store.state.nutrients.forEach((n) => {
    if (goals[n.name] == null) goals[n.name] = 0;
    const row = document.createElement("label");
    row.className = "goal-row";
    row.innerHTML = `<span>${n.name}</span><input type="number" step="0.01" min="0" data-name="${n.name}" value="${goals[n.name]}" /><span>${n.unit}</span>`;
    box.appendChild(row);
  });
}

function nutrientInputsHTML(prefix, values = {}, options = {}) {
  const { blankZero = false } = options;
  return store.state.nutrients
    .map((n) => {
      const v = values[n.name] ?? 0;
      const value = blankZero && Number(v) === 0 ? "" : v;
      const placeholder = blankZero ? ` placeholder="0"` : "";
      return `<label class="goal-row"><span>${n.name}</span><input type="number" min="0" step="0.01" data-prefix="${prefix}" data-name="${n.name}" value="${value}"${placeholder}/><span>${n.unit}</span></label>`;
    })
    .join("");
}

function renderFoodInputs() {
  $("food-nutrient-inputs").innerHTML = nutrientInputsHTML("food", {}, { blankZero: true });
  $("manual-intake-inputs").innerHTML = nutrientInputsHTML("manual");
  $("intake-edit-inputs").innerHTML = nutrientInputsHTML("intake-edit");

  const ocrValues = {};
  store.state.nutrients.forEach((n) => {
    ocrValues[n.name] = state.lastOcrParsed[n.name] || 0;
  });
  $("ocr-nutrient-inputs").innerHTML = nutrientInputsHTML("ocr", ocrValues, { blankZero: true });
  if (state.editingFoodId) {
    const editingFood = store.state.foods.find((f) => f.id === state.editingFoodId);
    if (editingFood) {
      document.querySelectorAll('[data-prefix="food"]').forEach((el) => {
        el.value = editingFood.nutrients[el.dataset.name] ?? 0;
      });
    }
  }
  if (state.editingIntakeLogId) {
    const editingLog = findIntakeLogById(state.activeDate, state.editingIntakeLogId);
    if (editingLog) {
      const editingNutrients = resolveLogNutrients(editingLog);
      document.querySelectorAll('[data-prefix="intake-edit"]').forEach((el) => {
        el.value = editingNutrients?.[el.dataset.name] ?? 0;
      });
      $("intake-edit-source").value = resolveLogSource(editingLog);
      setIntakeEditVisible(true);
    } else {
      exitIntakeEdit();
    }
  }
  bindTemplateNumberInputBehavior();
}

function bindTemplateNumberInputBehavior() {
  document
    .querySelectorAll("#food-form input[type='number'], #ocr-food-form input[type='number']")
    .forEach((el) => {
      if (el.dataset.boundTemplateNumber === "1") return;
      el.dataset.boundTemplateNumber = "1";

      el.addEventListener("focus", () => {
        if (!el.value) return;
        if (typeof el.select === "function") {
          setTimeout(() => el.select(), 0);
        }
      });

      // 输入时去掉前导零: 04 -> 4, 00.5 -> 0.5
      el.addEventListener("input", () => {
        const raw = el.value;
        if (!raw) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        if (/^0\d/.test(raw) || /^0+\.?\d+/.test(raw)) {
          el.value = String(n);
        }
      });
    });
}

function renderFoodList() {
  const box = $("food-list");
  box.innerHTML = "";
  const searchInput = $("consume-food-search");
  const select = $("consume-food-id");
  const submitBtn = $("consume-food-submit");
  const emptyTip = $("consume-food-empty");

  if (searchInput && searchInput.value !== state.foodSearchKeyword) {
    searchInput.value = state.foodSearchKeyword;
  }

  if (!store.state.foods.length) {
    box.innerHTML = `<p class="hint">No foods yet. Add one first.</p>`;
    select.innerHTML = `<option value="${ADD_NEW_FOOD_OPTION_VALUE}">+ Add New Food</option>`;
    if (searchInput) searchInput.disabled = true;
    select.disabled = false;
    submitBtn.disabled = false;
    emptyTip.textContent = "Choose '+ Add New Food' in the dropdown to create a template.";
    $("consume-unit").value = "";
    state.lastSelectedFoodId = "";
    return;
  }

  if (searchInput) searchInput.disabled = false;

  store.state.foods.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className = "food-row";
    row.innerHTML = `<strong>${f.name}</strong><span>${f.baseAmount}${f.baseUnit}</span><span>${Object.entries(f.nutrients)
      .map(([k, v]) => `${k}:${v}`)
      .join(" | ")}</span><div class="food-actions"><button class="btn-secondary" data-action="edit" data-id="${f.id}">Edit</button><button data-action="delete" data-idx="${idx}">Delete</button></div>`;
    row.querySelector('[data-action="edit"]').onclick = () => {
      enterFoodEdit(f.id);
    };
    row.querySelector('[data-action="delete"]').onclick = () => {
      store.state.foods.splice(idx, 1);
      if (state.editingFoodId === f.id) {
        exitFoodEdit();
      }
      store.save();
      rerenderAll();
    };
    box.appendChild(row);
  });

  select.disabled = false;
  submitBtn.disabled = false;
  const filteredFoods = filterFoodsByKeyword(state.foodSearchKeyword);
  const options = filteredFoods.map((f) => `<option value="${f.id}">${f.name} (per ${f.baseAmount}${f.baseUnit})</option>`);
  if (!filteredFoods.length) {
    const keyword = state.foodSearchKeyword.trim();
    options.push(`<option value="" disabled selected>${keyword ? `No match for "${keyword}"` : "No available foods"}</option>`);
  }
  options.push(`<option value="${ADD_NEW_FOOD_OPTION_VALUE}">+ Add New Food</option>`);
  select.innerHTML = options.join("");

  if (!filteredFoods.length) {
    select.value = "";
    $("consume-unit").value = "";
    emptyTip.textContent = "No matches. You can choose '+ Add New Food'.";
    return;
  }

  const hasLast = state.lastSelectedFoodId && filteredFoods.some((f) => f.id === state.lastSelectedFoodId);
  const chosenId = hasLast ? state.lastSelectedFoodId : filteredFoods[0].id;
  select.value = chosenId;
  state.lastSelectedFoodId = chosenId;
  const chosenFood = filteredFoods.find((f) => f.id === chosenId);
  if (chosenFood) $("consume-unit").value = chosenFood.baseUnit;
  emptyTip.textContent = state.foodSearchKeyword.trim()
    ? `Search results: ${filteredFoods.length}/${store.state.foods.length}`
    : "";
}

function sumIntake(date) {
  ensureDateSlots(date);
  const logs = store.state.intakeLogsByDate[date] || [];
  if (logs.length) {
    const total = {};
    logs.forEach((log) => {
      const nutrients = resolveLogNutrients(log);
      Object.entries(nutrients || {}).forEach(([k, v]) => {
        total[k] = Number(((total[k] || 0) + Number(v || 0)).toFixed(4));
      });
    });
    return total;
  }
  return store.state.intakeByDate[date] || {};
}

function resolveLogNutrients(log) {
  const foodRaw = resolveFoodForLog(log);
  if (foodRaw) {
    log.type = "food";
    log.foodId = foodRaw.id;
    log.foodName = foodRaw.name;
    const amount = parseAmountFromSource(log.source, log.amount || foodRaw.baseAmount);
    log.amount = amount;
    const food = new Food(foodRaw);
    return food.intakeFor(amount);
  }
  return log?.nutrients || {};
}

function resolveLogSource(log) {
  const foodRaw = resolveFoodForLog(log);
  if (foodRaw) {
    log.type = "food";
    log.foodId = foodRaw.id;
    log.foodName = foodRaw.name;
    const amount = parseAmountFromSource(log.source, log.amount || foodRaw.baseAmount);
    log.amount = amount;
    return `${foodRaw.name} ${amount}${foodRaw.baseUnit}`;
  }
  return log?.source || "Intake Log";
}

function renderRemaining() {
  const goals = store.state.defaultGoals || {};
  const intake = sumIntake(state.activeDate);
  const remain = RecommendationEngine.remaining(goals, intake);

  const box = $("remaining-panel");
  box.innerHTML = "";
  store.state.nutrients.forEach((n) => {
    const row = document.createElement("div");
    row.className = "remain-row";
    const g = Number(goals[n.name] || 0);
    const i = Number(intake[n.name] || 0);
    const r = Number(remain[n.name] || 0);
    row.innerHTML = `<span>${n.name}</span><span>Goal ${g}${n.unit} / Intake ${i}${n.unit}</span><strong style="color:${r < 0 ? "#b91c1c" : "#0f766e"}">Remaining ${r}${n.unit}</strong>`;
    box.appendChild(row);
  });
}

function rerenderAll() {
  renderNutrients();
  renderGoalForm();
  renderFoodInputs();
  renderFoodList();
  renderIntakeLogs();
  renderRemaining();
  syncFoodFormMode();
  const llm = store.state.llm;
  $("llm-endpoint").value = llm.endpoint || "";
  $("llm-model").value = llm.model || "";
  $("llm-token").value = llm.token || "";
  const versionEl = $("app-version");
  if (versionEl) versionEl.textContent = `All data is stored only in this browser (localStorage) | Version ${APP_VERSION}`;
}

function collectNutrientValues(prefix) {
  const obj = {};
  document.querySelectorAll(`[data-prefix="${prefix}"]`).forEach((el) => {
    obj[el.dataset.name] = Number(el.value || 0);
  });
  return obj;
}

function appendIntakeLog(date, log) {
  ensureDateSlots(date);
  store.state.intakeLogsByDate[date].push(log);
}

function renderIntakeLogs() {
  ensureDateSlots(state.activeDate);
  const box = $("intake-log-list");
  const logs = store.state.intakeLogsByDate[state.activeDate] || [];
  box.innerHTML = "";
  if (!logs.length) {
    box.innerHTML = `<p class="hint">No intake logs for today.</p>`;
    return;
  }
  logs
    .slice()
    .reverse()
    .forEach((log) => {
      const row = document.createElement("div");
      row.className = "intake-log-row";
      const nutrientsText = Object.entries(resolveLogNutrients(log))
        .map(([k, v]) => `${k}:${Number(v)}`)
        .join(" | ");
      const resolvedFood = resolveFoodForLog(log);
      const bindTag = resolvedFood ? `<span class="hint">[Linked Template]</span>` : "";
      row.innerHTML = `<div><strong>${resolveLogSource(log)}</strong> ${bindTag}<div class="hint">${new Date(
        log.createdAt
      ).toLocaleString()}</div></div><div>${nutrientsText}</div><div class="food-actions"><button class="btn-secondary" data-action="edit" data-id="${log.id}">Edit</button><button data-action="delete" data-id="${log.id}">Delete</button></div>`;
      row.querySelector('[data-action="delete"]').onclick = () => {
        const arr = store.state.intakeLogsByDate[state.activeDate] || [];
        store.state.intakeLogsByDate[state.activeDate] = arr.filter((x) => x.id !== log.id);
        if (state.editingIntakeLogId === log.id) {
          exitIntakeEdit();
        }
        store.save();
        rerenderAll();
      };
      row.querySelector('[data-action="edit"]').onclick = () => {
        enterIntakeEdit(log.id);
      };
      box.appendChild(row);
    });
}

function parseNutritionFromText(text) {
  const normalized = text.replace(/,/g, ".").toLowerCase();
  const out = {};

  const patterns = [
    { keys: ["calories", "energy", "热量"], to: "Calories" },
    { keys: ["protein", "蛋白"], to: "Protein" },
    { keys: ["fat", "total fat", "脂肪"], to: "Fat" },
    { keys: ["carbohydrate", "carb", "碳水"], to: "Carbs" }
  ];

  patterns.forEach((p) => {
    for (const k of p.keys) {
      const re = new RegExp(`${k}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i");
      const m = normalized.match(re);
      if (m) {
        out[p.to] = Number(m[1]);
        break;
      }
    }
  });

  // 通用提取: 名称 + 数值 + 单位（优先匹配已存在营养素）
  store.state.nutrients.forEach((n) => {
    const escaped = n.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)`, "i");
    const m = normalized.match(re);
    if (m) out[n.name] = Number(m[1]);
  });

  return out;
}

async function runOCR() {
  const file = $("label-image").files?.[0];
  if (!file) {
    alert("Please select or capture an image first.");
    return;
  }
  $("ocr-text").textContent = "Recognizing, please wait...";
  const { data } = await Tesseract.recognize(file, "eng+chi_sim", {
    logger: () => {}
  });
  const text = data?.text || "";
  $("ocr-text").textContent = text;

  state.lastOcrParsed = parseNutritionFromText(text);
  renderFoodInputs();
  alert("OCR complete. Please review and correct nutrient values before saving.");
}

async function askLLMPlan() {
  const endpoint = $("llm-endpoint").value.trim();
  const model = $("llm-model").value.trim();
  const token = $("llm-token").value.trim();

  store.state.llm = { endpoint, model, token };
  store.save();

  if (!endpoint || !model || !token) {
    alert("Please fill endpoint / model / token.");
    return;
  }

  const goals = store.state.defaultGoals || {};
  const intake = sumIntake(state.activeDate);
  const deficits = RecommendationEngine.remaining(goals, intake);

  const prompt = `You are a nutrition planning assistant.\nToday's goals: ${JSON.stringify(goals)}\nToday's intake: ${JSON.stringify(
    intake
  )}\nRemaining gaps: ${JSON.stringify(deficits)}\nAvailable foods: ${JSON.stringify(
    store.state.foods.map((f) => ({ name: f.name, baseAmount: f.baseAmount, baseUnit: f.baseUnit, nutrients: f.nutrients }))
  )}\nPlease provide 2-3 meal options that best fit the gaps and explain why.`;

  $("llm-result").textContent = "Generating with LLM...";
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: "system", content: "You are a professional nutritionist. Keep answers concise and actionable." },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "No content returned.";
    $("llm-result").textContent = content;
  } catch (e) {
    $("llm-result").textContent = `Request failed: ${e.message}`;
  }
}

function bindEvents() {
  $("active-date").value = state.activeDate;
  $("consume-food-search").oninput = (e) => {
    state.foodSearchKeyword = e.target.value;
    renderFoodList();
  };
  $("active-date").onchange = (e) => {
    state.activeDate = e.target.value;
    ensureDateSlots(state.activeDate);
    exitIntakeEdit();
    rerenderAll();
  };

  $("nutrient-form").onsubmit = (e) => {
    e.preventDefault();
    const name = $("nutrient-name").value.trim();
    const unit = $("nutrient-unit").value.trim();
    if (!name || !unit) return;
    if (store.state.nutrients.some((n) => n.name === name)) {
      alert("This nutrient already exists.");
      return;
    }
    store.state.nutrients.push({ name, unit });
    store.state.defaultGoals[name] = 0;
    Object.values(store.state.intakeByDate).forEach((i) => (i[name] = i[name] || 0));
    store.save();
    e.target.reset();
    rerenderAll();
  };

  $("save-goal").onclick = () => {
    document.querySelectorAll("#goal-form-container input[data-name]").forEach((el) => {
      store.state.defaultGoals[el.dataset.name] = Number(el.value || 0);
    });
    store.save();
    rerenderAll();
    alert("Goals saved.");
  };

  $("food-form").onsubmit = (e) => {
    e.preventDefault();
    try {
      const editingFood = state.editingFoodId ? store.state.foods.find((f) => f.id === state.editingFoodId) : null;
      const id = editingFood?.id || createId();
      const name = $("food-name").value.trim();
      const baseAmount = Number($("food-serving-amount").value);
      const baseUnit = $("food-serving-unit").value.trim();
      if (!name || !baseUnit || !Number.isFinite(baseAmount) || baseAmount <= 0) {
        alert("Please check food name, serving amount, and unit.");
        return;
      }
      if (hasFoodNameConflict(name, editingFood?.id || null)) {
        alert("This food template name already exists. Rename it or edit the existing template.");
        return;
      }
      const food = new Food({
        id,
        name,
        baseAmount,
        baseUnit,
        nutrients: collectNutrientValues("food")
      });
      if (editingFood) {
        const idx = store.state.foods.findIndex((f) => f.id === id);
        if (idx >= 0) store.state.foods[idx] = food;
      } else {
        store.state.foods.push(food);
      }
      relinkFoodLogsByFood(food);
      store.save();
      exitFoodEdit();
      state.lastSelectedFoodId = id;
      if (state.foodSearchKeyword && !normalizeFoodName(name).includes(normalizeFoodName(state.foodSearchKeyword))) {
        state.foodSearchKeyword = "";
      }
      rerenderAll();
      $("consume-food-id").value = id;
      $("consume-unit").value = baseUnit;
      setFoodManagerVisible(false);
      alert(editingFood ? "Template updated." : "Food saved.");
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  };

  $("run-ocr").onclick = () => runOCR();

  $("ocr-food-form").onsubmit = (e) => {
    e.preventDefault();
    try {
      const id = createId();
      const name = $("ocr-food-name").value.trim();
      const baseAmount = Number($("ocr-serving-amount").value);
      const baseUnit = $("ocr-serving-unit").value.trim();
      if (!name || !baseUnit || !Number.isFinite(baseAmount) || baseAmount <= 0) {
        alert("Please check food name, serving amount, and unit.");
        return;
      }
      if (hasFoodNameConflict(name)) {
        alert("This food template name already exists. Rename it or edit the existing template.");
        return;
      }
      const food = new Food({
        id,
        name,
        baseAmount,
        baseUnit,
        nutrients: collectNutrientValues("ocr")
      });
      store.state.foods.push(food);
      relinkFoodLogsByFood(food);
      store.save();
      e.target.reset();
      state.lastOcrParsed = {};
      $("ocr-text").textContent = "";
      state.lastSelectedFoodId = id;
      if (state.foodSearchKeyword && !normalizeFoodName(name).includes(normalizeFoodName(state.foodSearchKeyword))) {
        state.foodSearchKeyword = "";
      }
      rerenderAll();
      $("consume-food-id").value = id;
      $("consume-unit").value = baseUnit;
      setFoodManagerVisible(false);
      alert("OCR food saved.");
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    }
  };

  $("consume-food-form").onsubmit = (e) => {
    e.preventDefault();
    const id = $("consume-food-id").value;
    if (!id) {
      alert("Please select a food first.");
      return;
    }
    if (id === ADD_NEW_FOOD_OPTION_VALUE) {
      setFoodManagerVisible(true);
      setFoodModalTab("manual");
      return;
    }
    const amount = Number($("consume-amount").value);
    const unit = $("consume-unit").value.trim();
    const foodRaw = store.state.foods.find((f) => f.id === id);
    if (!foodRaw) return;
    if (unit && unit !== foodRaw.baseUnit) {
      alert(`Unit mismatch: this food uses base unit ${foodRaw.baseUnit}.`);
      return;
    }
    const food = new Food(foodRaw);
    const delta = food.intakeFor(amount);
    appendIntakeLog(state.activeDate, {
      id: createId(),
      type: "food",
      foodId: foodRaw.id,
      foodName: foodRaw.name,
      amount,
      createdAt: new Date().toISOString(),
      nutrients: delta
    });
    store.save();
    rerenderAll();
    alert("Food intake logged.");
  };

  $("manual-intake-form").onsubmit = (e) => {
    e.preventDefault();
    const delta = collectNutrientValues("manual");
    appendIntakeLog(state.activeDate, {
      id: createId(),
      type: "manual",
      source: "Manual Entry",
      createdAt: new Date().toISOString(),
      nutrients: delta
    });
    store.save();
    rerenderAll();
    alert("Manual intake logged.");
  };

  $("run-recommend").onclick = () => {
    const goals = store.state.defaultGoals || {};
    const intake = sumIntake(state.activeDate);
    const deficits = RecommendationEngine.remaining(goals, intake);
    const { picks, remain } = RecommendationEngine.suggestFoods(store.state.foods, deficits, 4);

    const lines = [];
    if (!picks.length) {
      lines.push("No recommendation available: add foods first, or there is no positive gap now.");
    } else {
      lines.push("Suggested combination:");
      picks.forEach((p, i) => {
        const f = store.state.foods.find((x) => x.id === p.foodId);
        lines.push(`${i + 1}. ${f?.name || "Unknown Food"} ${p.amount}${p.unit}`);
      });
    }
    lines.push("Estimated remaining gaps after this combination:");
    store.state.nutrients.forEach((n) => {
      lines.push(`${n.name}: ${Number(remain[n.name] || 0)} ${n.unit}`);
    });

    $("recommend-result").textContent = lines.join("\n");
  };

  $("consume-food-id").onchange = () => {
    const id = $("consume-food-id").value;
    if (id === ADD_NEW_FOOD_OPTION_VALUE) {
      setFoodManagerVisible(true);
      setFoodModalTab("manual");
      renderFoodList();
      return;
    }
    if (!id) {
      $("consume-unit").value = "";
      return;
    }
    state.lastSelectedFoodId = id;
    const foodRaw = store.state.foods.find((f) => f.id === id);
    if (foodRaw) $("consume-unit").value = foodRaw.baseUnit;
  };
  // 初始无食物时，点击下拉框直接打开“添加新的食物”弹窗
  $("consume-food-id").onmousedown = (e) => {
    if (store.state.foods.length) return;
    e.preventDefault();
    setFoodManagerVisible(true);
    setFoodModalTab("manual");
  };
  $("consume-food-id").ontouchstart = () => {
    if (store.state.foods.length) return;
    setFoodManagerVisible(true);
    setFoodModalTab("manual");
  };
  $("food-modal-backdrop").onclick = () => {
    setFoodManagerVisible(false);
    exitFoodEdit();
  };
  $("food-tab-manual").onclick = () => setFoodModalTab("manual");
  $("food-tab-ocr").onclick = () => setFoodModalTab("ocr");
  $("food-cancel-edit").onclick = () => {
    exitFoodEdit();
  };
  $("intake-edit-cancel").onclick = () => exitIntakeEdit();
  $("intake-edit-form").onsubmit = (e) => {
    e.preventDefault();
    const id = state.editingIntakeLogId;
    if (!id) return;
    const logs = store.state.intakeLogsByDate[state.activeDate] || [];
    const idx = logs.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const resolvedFood = resolveFoodForLog(logs[idx]);
    if (resolvedFood) {
      const amount = Number($("intake-edit-food-amount").value);
      if (!Number.isFinite(amount) || amount <= 0) {
        alert("Please enter a valid intake amount.");
        return;
      }
      logs[idx] = {
        ...logs[idx],
        type: "food",
        foodId: resolvedFood.id,
        foodName: resolvedFood.name,
        amount
      };
    } else {
      logs[idx] = {
        ...logs[idx],
        source: $("intake-edit-source").value.trim() || logs[idx].source || "Intake Log",
        nutrients: collectNutrientValues("intake-edit")
      };
    }
    store.save();
    exitIntakeEdit();
    rerenderAll();
    alert("Intake log updated.");
  };
  $("undo-last-intake").onclick = () => {
    ensureDateSlots(state.activeDate);
    if (!store.state.intakeLogsByDate[state.activeDate].length) {
      alert("No intake log to undo today.");
      return;
    }
    store.state.intakeLogsByDate[state.activeDate].pop();
    if (!findIntakeLogById(state.activeDate, state.editingIntakeLogId)) {
      exitIntakeEdit();
    }
    store.save();
    rerenderAll();
    alert("Last entry undone.");
  };
  $("clear-day-intake").onclick = () => {
    ensureDateSlots(state.activeDate);
    store.state.intakeLogsByDate[state.activeDate] = [];
    store.state.intakeByDate[state.activeDate] = {};
    exitIntakeEdit();
    store.save();
    rerenderAll();
    alert("Today's logs cleared.");
  };

  $("llm-form").onsubmit = (e) => {
    e.preventDefault();
    askLLMPlan();
  };
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`./sw.js?${APP_VERSION}`).then((reg) => reg.update());
  });
}

ensureDateSlots(state.activeDate);
relinkAllFoodLogs();
store.save();
bindEvents();
rerenderAll();
setFoodManagerVisible(false);
setFoodModalTab("manual");
