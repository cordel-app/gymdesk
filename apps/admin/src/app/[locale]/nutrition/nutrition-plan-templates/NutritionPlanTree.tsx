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
import { btnStyle } from '@/components/ui';

/* Types returned by GET /nutrition-plan-templates/:id/hierarchy */
export interface HierMealDish {
  id: number; position: number;
  dish_id: number; dish_name: string; dish_description: string | null;
  dish_calories: number | null; dish_protein: number | null;
  dish_carbohydrates: number | null; dish_fat: number | null;
  side_id: number | null; side_name: string | null;
  sauce_id: number | null; sauce_name: string | null;
}
export interface HierMeal {
  id: number; name: string; position: number;
  dishes: HierMealDish[] | null;
}
export interface HierDay {
  id: number; weekday: number; position: number;
  meals: HierMeal[] | null;
}
export interface Hierarchy {
  id: number; name: string; status: string;
  days: HierDay[] | null;
}

interface DishOption { id: number; name: string }
interface SideOption { id: number; name: string }
interface SauceOption { id: number; name: string }

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

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

  // Catalog options — loaded once
  const [dishOptions, setDishOptions] = useState<DishOption[]>([]);
  const [sideOptions, setSideOptions] = useState<SideOption[]>([]);
  const [sauceOptions, setSauceOptions] = useState<SauceOption[]>([]);

  useEffect(() => {
    apiFetch<DishOption[]>('/dishes').then(setDishOptions).catch(() => {});
    apiFetch<SideOption[]>('/sides').then(setSideOptions).catch(() => {});
    apiFetch<SauceOption[]>('/sauces').then(setSauceOptions).catch(() => {});
  }, []);

  // Add day
  const [addingDay, setAddingDay] = useState(false);
  const [addDayWeekday, setAddDayWeekday] = useState('');

  // Remove day confirm
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

  const availableWeekdays = WEEKDAYS.filter((w) => !usedWeekdays.has(w));

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {/* Add day */}
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
                dishOptions={dishOptions}
                sideOptions={sideOptions}
                sauceOptions={sauceOptions}
                onRemoveDay={() => setRemovingDay(day)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

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

function DayRow({
  day, templateId, canWrite, dishOptions, sideOptions, sauceOptions, onRemoveDay, onChanged,
}: {
  day: HierDay;
  templateId: number;
  canWrite: boolean;
  dishOptions: DishOption[];
  sideOptions: SideOption[];
  sauceOptions: SauceOption[];
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
  const [addMealName, setAddMealName] = useState('');
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
    if (!addMealName.trim()) { toast(t('nutrition_plan_templates.tree_meal_name_required')); return; }
    setAddingMeal(true);
    try {
      await apiFetch(`${base}/meals`, { method: 'POST', body: JSON.stringify({ name: addMealName.trim() }) });
      setAddMealName('');
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

  return (
    <div ref={setNodeRef} style={style}>
      {/* Day header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none' }}>⠿</span>
        )}
        <span style={{ fontWeight: 700, fontSize: 15 }}>{t(`workouts.weekday_${day.weekday}`)}</span>
        <span style={{ flex: 1 }} />
        {canWrite && (
          <ContextMenu
            ariaLabel={t('nutrition_plan_templates.col_actions')}
            items={[{ label: t('nutrition_plan_templates.tree_remove_day'), onClick: onRemoveDay, danger: true }]}
          />
        )}
      </div>

      {/* Meals */}
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
                dishOptions={dishOptions}
                sideOptions={sideOptions}
                sauceOptions={sauceOptions}
                onRemove={() => setRemovingMeal(meal)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Add meal */}
        {canWrite && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
            <input
              value={addMealName}
              onChange={(e) => setAddMealName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addMeal(); }}
              placeholder={t('nutrition_plan_templates.tree_meal_placeholder')}
              style={{ ...selectStyle, flex: 1 }}
            />
            <button onClick={addMeal} disabled={addingMeal} style={btnStyle('sm')}>
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

function MealRow({
  meal, templateId, dayId, canWrite, dishOptions, sideOptions, sauceOptions, onRemove, onChanged,
}: {
  meal: HierMeal;
  templateId: number;
  dayId: number;
  canWrite: boolean;
  dishOptions: DishOption[];
  sideOptions: SideOption[];
  sauceOptions: SauceOption[];
  onRemove: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: meal.id });

  const [dishes, setDishes] = useState<HierMealDish[]>(meal.dishes ?? []);
  useEffect(() => { setDishes(meal.dishes ?? []); }, [meal]);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(meal.name);
  const [addingDish, setAddingDish] = useState(false);
  const [addDishId, setAddDishId] = useState('');
  const [removingDish, setRemovingDish] = useState<HierMealDish | null>(null);

  const base = `/nutrition-plan-templates/${templateId}/days/${dayId}/meals/${meal.id}`;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function saveMealName() {
    if (!nameValue.trim()) { setNameValue(meal.name); setEditingName(false); return; }
    try {
      await apiFetch(base, { method: 'PUT', body: JSON.stringify({ name: nameValue.trim() }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
      setNameValue(meal.name);
    }
    setEditingName(false);
  }

  async function onDishDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = dishes.findIndex((d) => d.id === active.id);
    const newIndex = dishes.findIndex((d) => d.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(dishes, oldIndex, newIndex);
    setDishes(reordered);
    try {
      await apiFetch(`${base}/dishes/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((d) => d.id) }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
      await onChanged();
    }
  }

  async function addDish() {
    if (!addDishId) { toast(t('nutrition_plan_templates.tree_pick_dish')); return; }
    setAddingDish(true);
    try {
      await apiFetch(`${base}/dishes`, { method: 'POST', body: JSON.stringify({ dish_id: parseInt(addDishId, 10) }) });
      setAddDishId('');
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    } finally { setAddingDish(false); }
  }

  async function updateDishSideOrSauce(mealDishId: number, field: 'side_id' | 'sauce_id', value: string) {
    try {
      await apiFetch(`${base}/dishes/${mealDishId}`, {
        method: 'PUT',
        body: JSON.stringify({ [field]: value === '' ? null : parseInt(value, 10) }),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  async function removeDish() {
    if (!removingDish) return;
    try {
      await apiFetch(`${base}/dishes/${removingDish.id}`, { method: 'DELETE' });
      setRemovingDish(null);
      await onChanged();
    } catch (err: any) {
      setRemovingDish(null);
      toast(err.message ?? t('nutrition_plan_templates.error_generic'));
    }
  }

  const mealStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#fff',
    border: '1px solid #ececf0',
    borderRadius: 6,
    padding: '10px 12px',
    marginBottom: 8,
  };

  return (
    <div ref={setNodeRef} style={mealStyle}>
      {/* Meal header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#bbb', fontSize: 14, userSelect: 'none' }}>⠿</span>
        )}
        {editingName && canWrite ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={saveMealName}
            onKeyDown={(e) => { if (e.key === 'Enter') saveMealName(); if (e.key === 'Escape') { setNameValue(meal.name); setEditingName(false); } }}
            style={{ ...selectStyle, fontWeight: 600, fontSize: 14 }}
          />
        ) : (
          <span
            style={{ fontWeight: 600, fontSize: 14, cursor: canWrite ? 'text' : 'default' }}
            onClick={() => canWrite && setEditingName(true)}
            title={canWrite ? t('nutrition_plan_templates.tree_click_to_edit') : undefined}
          >
            {meal.name}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {canWrite && (
          <ContextMenu
            ariaLabel={t('nutrition_plan_templates.col_actions')}
            items={[{ label: t('nutrition_plan_templates.tree_remove_meal'), onClick: onRemove, danger: true }]}
          />
        )}
      </div>

      {/* Dish list */}
      <div style={{ paddingLeft: 8 }}>
        {dishes.length === 0 && (
          <p style={{ color: '#bbb', fontSize: 13, margin: '0 0 6px' }}>{t('nutrition_plan_templates.tree_no_dishes')}</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDishDragEnd}>
          <SortableContext items={dishes.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            {dishes.map((md) => (
              <DishItem
                key={md.id}
                mealDish={md}
                canWrite={canWrite}
                sideOptions={sideOptions}
                sauceOptions={sauceOptions}
                onUpdateSide={(v) => updateDishSideOrSauce(md.id, 'side_id', v)}
                onUpdateSauce={(v) => updateDishSideOrSauce(md.id, 'sauce_id', v)}
                onRemove={() => setRemovingDish(md)}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Add dish */}
        {canWrite && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <select value={addDishId} onChange={(e) => setAddDishId(e.target.value)} style={selectStyle}>
              <option value="">{t('nutrition_plan_templates.tree_select_dish')}</option>
              {dishOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button onClick={addDish} disabled={addingDish} style={btnStyle('sm')}>
              {t('nutrition_plan_templates.tree_add_dish')}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={removingDish !== null}
        message={t('nutrition_plan_templates.tree_confirm_remove_dish')}
        confirmLabel={t('nutrition_plan_templates.tree_remove_dish')}
        cancelLabel={t('nutrition_plan_templates.cancel')}
        onConfirm={removeDish}
        onCancel={() => setRemovingDish(null)}
      />
    </div>
  );
}

function DishItem({
  mealDish, canWrite, sideOptions, sauceOptions, onUpdateSide, onUpdateSauce, onRemove,
}: {
  mealDish: HierMealDish;
  canWrite: boolean;
  sideOptions: SideOption[];
  sauceOptions: SauceOption[];
  onUpdateSide: (value: string) => void;
  onUpdateSauce: (value: string) => void;
  onRemove: () => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: mealDish.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#f5f6fa',
    border: '1px solid #e8e9f0',
    borderRadius: 6,
    padding: '8px 10px',
    marginBottom: 6,
  };

  const macros = [
    mealDish.dish_calories != null ? `${mealDish.dish_calories} kcal` : null,
    mealDish.dish_protein != null ? `${mealDish.dish_protein}g protein` : null,
    mealDish.dish_carbohydrates != null ? `${mealDish.dish_carbohydrates}g carbs` : null,
    mealDish.dish_fat != null ? `${mealDish.dish_fat}g fat` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#ccc', fontSize: 13, userSelect: 'none' }}>⠿</span>
        )}
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>{mealDish.dish_name}</span>
          {macros && <span style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>{macros}</span>}
          {mealDish.dish_description && (
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: '#888' }}>{mealDish.dish_description}</p>
          )}
          {/* Side & Sauce selectors */}
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_label_side')}</span>
              {canWrite ? (
                <select
                  value={mealDish.side_id != null ? String(mealDish.side_id) : ''}
                  onChange={(e) => onUpdateSide(e.target.value)}
                  style={microSelect}
                >
                  <option value="">— {t('nutrition_plan_templates.tree_none')} —</option>
                  {sideOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 12.5, color: '#666' }}>{mealDish.side_name ?? '—'}</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={microLabel}>{t('nutrition_plan_templates.tree_label_sauce')}</span>
              {canWrite ? (
                <select
                  value={mealDish.sauce_id != null ? String(mealDish.sauce_id) : ''}
                  onChange={(e) => onUpdateSauce(e.target.value)}
                  style={microSelect}
                >
                  <option value="">— {t('nutrition_plan_templates.tree_none')} —</option>
                  {sauceOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 12.5, color: '#666' }}>{mealDish.sauce_name ?? '—'}</span>
              )}
            </div>
          </div>
        </div>
        {canWrite && (
          <ContextMenu
            ariaLabel={t('nutrition_plan_templates.col_actions')}
            items={[{ label: t('nutrition_plan_templates.tree_remove_dish'), onClick: onRemove, danger: true }]}
          />
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' };
const microLabel: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.3 };
const microSelect: React.CSSProperties = { padding: '3px 6px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12.5, background: '#fff' };
