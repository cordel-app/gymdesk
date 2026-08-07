'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle, btnSmall } from '@/components/ui';

interface LibraryItem { id: number; name: string; category: string }

export interface MealItem {
  id: number;
  nutrition_library_item_id: number;
  item_name: string;
  component_type: string;
  quantity: number | null;
  unit: string | null;
  position: number;
}

export interface HierMeal {
  id: number;
  display_name: string;
  meal_type: string | null;
  notes: string | null;
  position: number;
  items: MealItem[];
}
export interface HierDay {
  id: number; weekday: number; position: number;
  meals: HierMeal[] | null;
}
export interface HierRestriction {
  id: number; position: number;
  nutrition_library_item_id: number; item_name: string; item_category: string;
  applies_all_days: number;
}
export interface HierGoal {
  id: number; position: number;
  item_name: string; quantity: number; unit: string;
  frequency: string; applies_all_days: number;
}
export interface Hierarchy {
  id: number; name: string; status: string;
  days: HierDay[] | null;
  restrictions: HierRestriction[];
  goals: HierGoal[];
}

const MEAL_TYPES = [
  'recien_levantado', 'breakfast', 'media_manana',
  'lunch', 'snack', 'dinner', 'antes_de_dormir',
] as const;

const COMPONENT_TYPES = ['main_dish', 'side', 'sauce', 'additional'] as const;

const NUTRITION_GOALS = [
  'protein', 'water', 'calories', 'carbohydrates', 'fats', 'fiber',
  'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
  'performance', 'recovery', 'energy',
] as const;

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6, 7];

export function NutritionPlanTree({
  templateId, hierarchy, canWrite, onChanged,
}: {
  templateId: number;
  hierarchy: Hierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const base = `/nutrition-plan-templates/${templateId}`;

  const [days, setDays] = useState<HierDay[]>(hierarchy.days ?? []);
  useEffect(() => { setDays(hierarchy.days ?? []); }, [hierarchy]);

  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  useEffect(() => {
    apiFetch<LibraryItem[]>('/nutrition-library').then(setLibraryItems).catch(() => {});
  }, []);

  const [addingDay, setAddingDay] = useState(false);
  const [addDayWeekday, setAddDayWeekday] = useState('');
  const [removingDay, setRemovingDay] = useState<HierDay | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const usedWeekdays = new Set(days.map((d) => d.weekday));

  async function onDayDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = days.findIndex((d) => d.id === active.id);
    const newIndex = days.findIndex((d) => d.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(days, oldIndex, newIndex);
    setDays(reordered);
    try {
      await apiFetch(`${base}/days/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((d) => d.id) }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
      await onChanged();
    }
  }

  async function addDay() {
    if (addDayWeekday === '') { toast(t('nutrition_plan_templates.tree_pick_weekday')); return; }
    setAddingDay(true);
    try {
      await apiFetch(`${base}/days`, { method: 'POST', body: JSON.stringify({ weekday: parseInt(addDayWeekday, 10) }) });
      setAddDayWeekday('');
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAddingDay(false); }
  }

  async function removeDay() {
    if (!removingDay) return;
    try {
      await apiFetch(`${base}/days/${removingDay.id}`, { method: 'DELETE' });
      setRemovingDay(null);
      await onChanged();
    } catch (err: any) {
      setRemovingDay(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  const availableWeekdays = ALL_WEEKDAYS.filter((w) => !usedWeekdays.has(w));

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {canWrite && availableWeekdays.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
          <select value={addDayWeekday} onChange={(e) => setAddDayWeekday(e.target.value)} style={selectStyle}>
            <option value="">{t('nutrition_plan_templates.tree_select_weekday')}</option>
            {availableWeekdays.map((d) => (
              <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>
            ))}
          </select>
          <button onClick={addDay} disabled={addingDay} style={btnStyle()}>
            {addingDay ? t('nutrition_plan_templates.saving') : t('nutrition_plan_templates.tree_add_day')}
          </button>
        </div>
      )}

      {days.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '4px 0' }}>{t('nutrition_plan_templates.tree_no_days')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDayDragEnd}>
          <SortableContext items={days.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            {days.map((day) => (
              <DayRow
                key={day.id}
                day={day}
                templateId={templateId}
                canWrite={canWrite}
                libraryItems={libraryItems}
                onRemoveDay={() => setRemovingDay(day)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      <RestrictionsSection
        templateId={templateId}
        restrictions={hierarchy.restrictions ?? []}
        canWrite={canWrite}
        libraryItems={libraryItems}
        onChanged={onChanged}
      />

      <GoalsSection
        templateId={templateId}
        goals={hierarchy.goals ?? []}
        canWrite={canWrite}
        onChanged={onChanged}
      />

      <ConfirmDialog
        open={removingDay !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_day')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_day')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeDay}
        onCancel={() => setRemovingDay(null)}
      />
    </div>
  );
}

/* ---- DayRow ---- */

function DayRow({
  day, templateId, canWrite, libraryItems, onRemoveDay, onChanged,
}: {
  day: HierDay;
  templateId: number;
  canWrite: boolean;
  libraryItems: LibraryItem[];
  onRemoveDay: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: day.id });

  const [meals, setMeals] = useState<HierMeal[]>(day.meals ?? []);
  useEffect(() => { setMeals(day.meals ?? []); }, [day]);

  const [addingMeal, setAddingMeal] = useState(false);
  const [addMealType, setAddMealType] = useState('');
  const [removingMeal, setRemovingMeal] = useState<HierMeal | null>(null);

  const base = `/nutrition-plan-templates/${templateId}/days/${day.id}`;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onMealDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = meals.findIndex((m) => m.id === active.id);
    const newIndex = meals.findIndex((m) => m.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(meals, oldIndex, newIndex);
    setMeals(reordered);
    try {
      await apiFetch(`${base}/meals/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((m) => m.id) }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
      await onChanged();
    }
  }

  async function addMeal() {
    if (!addMealType) { toast(t('nutrition_plan_templates.tree_select_meal_type_required')); return; }
    setAddingMeal(true);
    try {
      await apiFetch(`${base}/meals`, { method: 'POST', body: JSON.stringify({ meal_type: addMealType }) });
      setAddMealType('');
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAddingMeal(false); }
  }

  async function removeMeal() {
    if (!removingMeal) return;
    try {
      await apiFetch(`${base}/meals/${removingMeal.id}`, { method: 'DELETE' });
      setRemovingMeal(null);
      await onChanged();
    } catch (err: any) {
      setRemovingMeal(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: '12px 14px',
    marginBottom: 12,
  };

  const weekdayLabel = t(`workouts.weekday_${day.weekday}`);

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none' }}>⠿</span>
        )}
        <span style={{ fontWeight: 700, fontSize: 15 }}>{weekdayLabel}</span>
        <span style={{ flex: 1 }} />
        {canWrite && (
          <ContextMenu
            ariaLabel={t('nutrition_plan_templates.col_actions')}
            items={[{ label: t('nutrition_plan_templates.tree_remove_day'), onClick: onRemoveDay, danger: true }]}
          />
        )}
      </div>

      <div style={{ paddingLeft: canWrite ? 26 : 0 }}>
        {meals.length === 0 && (
          <p style={{ color: '#aaa', fontSize: 13, margin: '0 0 8px' }}>{t('nutrition_plan_templates.tree_no_meals')}</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onMealDragEnd}>
          <SortableContext items={meals.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            {meals.map((meal) => (
              <MealRow
                key={meal.id}
                meal={meal}
                templateId={templateId}
                dayId={day.id}
                canWrite={canWrite}
                libraryItems={libraryItems}
                onRemove={() => setRemovingMeal(meal)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
        </DndContext>

        {canWrite && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
            <select
              value={addMealType}
              onChange={(e) => setAddMealType(e.target.value)}
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="">{t('nutrition_plan_templates.tree_select_meal_type')}</option>
              {MEAL_TYPES.map((mt) => (
                <option key={mt} value={mt}>{t(`nutrition_plan_templates.tree_meal_type_${mt}`)}</option>
              ))}
            </select>
            <button onClick={addMeal} disabled={addingMeal} style={btnSmall()}>
              {t('nutrition_plan_templates.tree_add_meal')}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removingMeal !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_meal')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_meal')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeMeal}
        onCancel={() => setRemovingMeal(null)}
      />
    </div>
  );
}

/* ---- MealRow ---- */

function MealRow({
  meal, templateId, dayId, canWrite, libraryItems, onRemove, onChanged,
}: {
  meal: HierMeal;
  templateId: number;
  dayId: number;
  canWrite: boolean;
  libraryItems: LibraryItem[];
  onRemove: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: meal.id });

  const [editing, setEditing] = useState(false);
  const [mealTypeVal, setMealTypeVal] = useState(meal.meal_type ?? '');
  const [displayNameVal, setDisplayNameVal] = useState(meal.display_name);
  const [notesVal, setNotesVal] = useState(meal.notes ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMealTypeVal(meal.meal_type ?? '');
    setDisplayNameVal(meal.display_name);
    setNotesVal(meal.notes ?? '');
  }, [meal]);

  const base = `/nutrition-plan-templates/${templateId}/days/${dayId}/meals/${meal.id}`;

  function cancelEdit() {
    setMealTypeVal(meal.meal_type ?? '');
    setDisplayNameVal(meal.display_name);
    setNotesVal(meal.notes ?? '');
    setEditing(false);
  }

  async function saveMeal() {
    setSaving(true);
    try {
      await apiFetch(base, {
        method: 'PUT',
        body: JSON.stringify({
          meal_type: mealTypeVal || undefined,
          display_name: displayNameVal.trim() || undefined,
          notes: notesVal.trim() || null,
        }),
      });
      await onChanged();
      setEditing(false);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setSaving(false); }
  }

  const compactSummary = meal.items.length > 0
    ? meal.items.map((i) => `${i.item_name}${i.quantity ? ` ${i.quantity}${i.unit ?? ''}` : ''}`).join(' · ')
    : null;

  const mealStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#fff',
    border: editing ? '1.5px solid #4b45c6' : '1px solid #ececf0',
    borderRadius: 6,
    marginBottom: 8,
    overflow: 'hidden',
  };

  return (
    <div ref={setNodeRef} style={mealStyle}>
      {/* Read-mode header (always visible) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px' }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#bbb', fontSize: 14, userSelect: 'none', flexShrink: 0 }}>⠿</span>
        )}
        <span style={{ fontWeight: 600, fontSize: 14, flexShrink: 0 }}>{meal.display_name}</span>
        {compactSummary && (
          <span style={{ fontSize: 12.5, color: '#6b7280', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {' · '}{compactSummary}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {canWrite && !editing && (
          <button
            onClick={() => setEditing(true)}
            style={{ background: 'none', border: '1px solid #ddd', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12, color: '#555' }}
          >
            {t('nutrition_plan_templates.edit')}
          </button>
        )}
        {canWrite && (
          <ContextMenu
            ariaLabel={t('nutrition_plan_templates.col_actions')}
            items={[{ label: t('nutrition_plan_templates.tree_remove_meal'), onClick: onRemove, danger: true }]}
          />
        )}
      </div>

      {/* Edit mode body */}
      {editing && (
        <div style={{ borderTop: '1px solid #ececf0', padding: '12px 12px 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_label_meal_type')}</span>
              <select
                value={mealTypeVal}
                onChange={(e) => setMealTypeVal(e.target.value)}
                style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const }}
              >
                <option value="">{t('nutrition_plan_templates.tree_select_meal_type')}</option>
                {MEAL_TYPES.map((mt) => (
                  <option key={mt} value={mt}>{t(`nutrition_plan_templates.tree_meal_type_${mt}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_label_display_name')}</span>
              <input
                value={displayNameVal}
                onChange={(e) => setDisplayNameVal(e.target.value)}
                style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const }}
              />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={microLabel}>{t('nutrition_plan_templates.tree_label_notes')}</span>
            <textarea
              value={notesVal}
              onChange={(e) => setNotesVal(e.target.value)}
              rows={2}
              style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          <MealItemsEditor
            templateId={templateId}
            dayId={dayId}
            mealId={meal.id}
            items={meal.items}
            libraryItems={libraryItems}
            canWrite={canWrite}
            onChanged={onChanged}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={cancelEdit} style={cancelBtnStyle}>{t('nutrition_plan_templates.cancel')}</button>
            <button onClick={saveMeal} disabled={saving} style={btnSmall()}>
              {saving ? t('nutrition_plan_templates.saving') : t('nutrition_plan_templates.save_changes')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- MealItemsEditor ---- */

const emptyItemForm = { nutrition_library_item_id: '', component_type: '', quantity: '', unit: 'g' };

function MealItemsEditor({
  templateId, dayId, mealId, items, libraryItems, canWrite, onChanged,
}: {
  templateId: number;
  dayId: number;
  mealId: number;
  items: MealItem[];
  libraryItems: LibraryItem[];
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [addForm, setAddForm] = useState(emptyItemForm);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const base = `/nutrition-plan-templates/${templateId}/days/${dayId}/meals/${mealId}/items`;

  async function addItem() {
    if (!addForm.nutrition_library_item_id || !addForm.component_type) {
      toast(t('nutrition_plan_templates.tree_item_required'));
      return;
    }
    setAdding(true);
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({
          nutrition_library_item_id: parseInt(addForm.nutrition_library_item_id, 10),
          component_type: addForm.component_type,
          quantity: addForm.quantity ? parseFloat(addForm.quantity) : null,
          unit: addForm.unit.trim() || null,
        }),
      });
      setAddForm(emptyItemForm);
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAdding(false); }
  }

  async function removeItem() {
    if (removingId == null) return;
    try {
      await apiFetch(`${base}/${removingId}`, { method: 'DELETE' });
      setRemovingId(null);
      await onChanged();
    } catch (err: any) {
      setRemovingId(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  return (
    <div style={{ borderTop: '1px solid #f0f0f5', paddingTop: 10 }}>
      <span style={microLabel}>{t('nutrition_plan_templates.tree_label_items')}</span>
      {items.length === 0 && (
        <p style={{ color: '#aaa', fontSize: 12.5, margin: '4px 0 8px' }}>{t('nutrition_plan_templates.tree_no_items')}</p>
      )}
      {items.map((item) => (
        <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderBottom: '1px solid #f5f5f8' }}>
          <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{item.item_name}</span>
          <span style={{ fontSize: 11.5, color: '#9ca3af' }}>
            {t(`nutrition_plan_templates.tree_component_type_${item.component_type}`)}
          </span>
          {item.quantity != null && (
            <span style={{ fontSize: 12.5, color: '#6b7280' }}>{item.quantity}{item.unit ?? ''}</span>
          )}
          {canWrite && (
            <button onClick={() => setRemovingId(item.id)} style={removeBtnStyle}>×</button>
          )}
        </div>
      ))}

      {canWrite && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 2, minWidth: 120 }}>
            <span style={microLabel}>{t('nutrition_plan_templates.tree_label_library_item')}</span>
            <select
              value={addForm.nutrition_library_item_id}
              onChange={(e) => setAddForm({ ...addForm, nutrition_library_item_id: e.target.value })}
              style={{ ...microSelect, width: '100%' }}
            >
              <option value="">—</option>
              {libraryItems.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <span style={microLabel}>{t('nutrition_plan_templates.tree_label_component_type')}</span>
            <select
              value={addForm.component_type}
              onChange={(e) => setAddForm({ ...addForm, component_type: e.target.value })}
              style={{ ...microSelect, width: '100%' }}
            >
              <option value="">—</option>
              {COMPONENT_TYPES.map((ct) => (
                <option key={ct} value={ct}>{t(`nutrition_plan_templates.tree_component_type_${ct}`)}</option>
              ))}
            </select>
          </div>
          <div style={{ width: 70 }}>
            <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_quantity')}</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={addForm.quantity}
              onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
              style={{ ...microSelect, width: '100%', boxSizing: 'border-box' as const }}
            />
          </div>
          <div style={{ width: 60 }}>
            <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_unit')}</span>
            <input
              value={addForm.unit}
              onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })}
              style={{ ...microSelect, width: '100%', boxSizing: 'border-box' as const }}
            />
          </div>
          <button onClick={addItem} disabled={adding} style={btnSmall()}>
            {t('nutrition_plan_templates.tree_add_item')}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={removingId !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_item')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_item')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeItem}
        onCancel={() => setRemovingId(null)}
      />
    </div>
  );
}

/* ---- RestrictionsSection ---- */

function RestrictionsSection({
  templateId, restrictions, canWrite, libraryItems, onChanged,
}: {
  templateId: number;
  restrictions: HierRestriction[];
  canWrite: boolean;
  libraryItems: LibraryItem[];
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [addItemId, setAddItemId] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const base = `/nutrition-plan-templates/${templateId}/restrictions`;

  async function addRestriction() {
    if (!addItemId) { toast(t('nutrition_plan_templates.tree_pick_restriction_item')); return; }
    setAdding(true);
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({ nutrition_library_item_id: parseInt(addItemId, 10), applies_all_days: 1 }),
      });
      setAddItemId('');
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAdding(false); }
  }

  async function removeRestriction() {
    if (removingId == null) return;
    try {
      await apiFetch(`${base}/${removingId}`, { method: 'DELETE' });
      setRemovingId(null);
      await onChanged();
    } catch (err: any) {
      setRemovingId(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  return (
    <div style={sectionStyle}>
      <h3 style={sectionHeaderStyle}>{t('nutrition_plan_templates.tree_section_restrictions')}</h3>
      {restrictions.length === 0 && (
        <p style={{ color: '#aaa', fontSize: 13, margin: '0 0 8px' }}>{t('nutrition_plan_templates.tree_no_restrictions')}</p>
      )}
      {restrictions.map((r) => (
        <div key={r.id} style={tagRowStyle}>
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>{r.item_name}</span>
          <span style={{ fontSize: 11.5, color: '#9ca3af', marginLeft: 6 }}>{r.item_category}</span>
          {canWrite && (
            <button onClick={() => setRemovingId(r.id)} style={removeBtnStyle}>×</button>
          )}
        </div>
      ))}
      {canWrite && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
          <select value={addItemId} onChange={(e) => setAddItemId(e.target.value)} style={selectStyle}>
            <option value="">{t('nutrition_plan_templates.tree_pick_restriction_item')}</option>
            {libraryItems.map((o) => (
              <option key={o.id} value={o.id}>{o.name} ({o.category})</option>
            ))}
          </select>
          <button onClick={addRestriction} disabled={adding} style={btnSmall()}>
            {t('nutrition_plan_templates.tree_add_restriction')}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={removingId !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_restriction')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_restriction')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeRestriction}
        onCancel={() => setRemovingId(null)}
      />
    </div>
  );
}

/* ---- GoalsSection ---- */

const emptyGoalForm = { item_name: '', quantity: '', unit: '', frequency: 'daily' };
type GoalForm = typeof emptyGoalForm;

function GoalsSection({
  templateId, goals, canWrite, onChanged,
}: {
  templateId: number;
  goals: HierGoal[];
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [addForm, setAddForm] = useState<GoalForm>(emptyGoalForm);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const base = `/nutrition-plan-templates/${templateId}/goals`;

  async function addGoal() {
    if (!addForm.item_name || !addForm.quantity || !addForm.unit.trim()) {
      toast(t('nutrition_plan_templates.tree_goal_required'));
      return;
    }
    setAdding(true);
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({
          item_name: addForm.item_name,
          quantity: parseFloat(addForm.quantity),
          unit: addForm.unit.trim(),
          frequency: addForm.frequency,
          applies_all_days: 1,
        }),
      });
      setAddForm(emptyGoalForm);
      setAddOpen(false);
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAdding(false); }
  }

  async function removeGoal() {
    if (removingId == null) return;
    try {
      await apiFetch(`${base}/${removingId}`, { method: 'DELETE' });
      setRemovingId(null);
      await onChanged();
    } catch (err: any) {
      setRemovingId(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  return (
    <div style={sectionStyle}>
      <h3 style={sectionHeaderStyle}>{t('nutrition_plan_templates.tree_section_goals')}</h3>
      {goals.length === 0 && (
        <p style={{ color: '#aaa', fontSize: 13, margin: '0 0 8px' }}>{t('nutrition_plan_templates.tree_no_goals')}</p>
      )}
      {goals.map((g) => (
        <div key={g.id} style={tagRowStyle}>
          <span style={{ fontSize: 13.5, fontWeight: 500 }}>
            {t(`nutrition_plan_templates.tree_goal_name_${g.item_name}`, { defaultValue: g.item_name })}
          </span>
          <span style={{ fontSize: 12.5, color: '#6b7280', marginLeft: 8 }}>{g.quantity} {g.unit} · {g.frequency}</span>
          {canWrite && (
            <button onClick={() => setRemovingId(g.id)} style={removeBtnStyle}>×</button>
          )}
        </div>
      ))}
      {canWrite && !addOpen && (
        <button onClick={() => setAddOpen(true)} style={{ ...btnSmall(), marginTop: 8 }}>
          {t('nutrition_plan_templates.tree_add_goal')}
        </button>
      )}
      {canWrite && addOpen && (
        <div style={{ marginTop: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_item_name')}</span>
              <select
                autoFocus
                value={addForm.item_name}
                onChange={(e) => setAddForm({ ...addForm, item_name: e.target.value })}
                style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const }}
              >
                <option value="">—</option>
                {NUTRITION_GOALS.map((g) => (
                  <option key={g} value={g}>{t(`nutrition_plan_templates.tree_goal_name_${g}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_quantity')}</span>
              <input
                type="number"
                min="0"
                step="0.1"
                value={addForm.quantity}
                onChange={(e) => setAddForm({ ...addForm, quantity: e.target.value })}
                style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const }}
              />
            </div>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_unit')}</span>
              <input
                value={addForm.unit}
                onChange={(e) => setAddForm({ ...addForm, unit: e.target.value })}
                placeholder="g, ml, kcal…"
                style={{ ...selectStyle, width: '100%', boxSizing: 'border-box' as const }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_goal_frequency')}</span>
              <select
                value={addForm.frequency}
                onChange={(e) => setAddForm({ ...addForm, frequency: e.target.value })}
                style={microSelect}
              >
                <option value="daily">{t('nutrition_plan_templates.tree_goal_frequency_daily')}</option>
                <option value="weekly">{t('nutrition_plan_templates.tree_goal_frequency_weekly')}</option>
              </select>
            </div>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => { setAddForm(emptyGoalForm); setAddOpen(false); }}
              style={cancelBtnStyle}
            >
              {t('nutrition_plan_templates.cancel')}
            </button>
            <button onClick={addGoal} disabled={adding} style={btnSmall()}>
              {adding ? t('nutrition_plan_templates.saving') : t('nutrition_plan_templates.tree_add_goal')}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={removingId !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_goal')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_goal')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeGoal}
        onCancel={() => setRemovingId(null)}
      />
    </div>
  );
}

const selectStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' };
const microLabel: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 3 };
const microSelect: React.CSSProperties = { padding: '5px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 13, background: '#fff' };
const sectionStyle: React.CSSProperties = { marginTop: 20, borderTop: '1px solid #e5e7eb', paddingTop: 14 };
const sectionHeaderStyle: React.CSSProperties = { margin: '0 0 10px', fontSize: 13.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 };
const tagRowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: '1px solid #f3f4f6' };
const removeBtnStyle: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: '#d1d5db', fontSize: 18, padding: '0 4px', marginLeft: 'auto', lineHeight: 1, fontWeight: 300 };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 14 };
