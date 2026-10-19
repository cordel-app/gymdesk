'use client';

import { ReactNode, useState } from 'react';
import type { NavParent } from '@/config/navigationGroups';
import { NavIcon } from './icons/NavIcons';
import { navGroupHeaderStyle } from './NavGroup';

interface NavParentGroupProps {
  parent: NavParent;
  label: string;
  isExpanded: boolean;
  onToggle: () => void;
  /** The open page is inside one of the parent's groups. */
  isAnyChildActive: boolean;
  collapsed?: boolean;
  /** The nested `NavGroup`s, rendered only while the parent is open. */
  children: ReactNode;
}

/**
 * #1819: the first-level entry that holds other sections (Organization). It is
 * the same header every section wears, so it reads as a sibling of Home,
 * Members and Calendar; it navigates nowhere — it only opens and closes — and,
 * collapsed to icons, it stands in for the active page inside it exactly as a
 * section does (#1003).
 */
export function NavParentGroup({
  parent,
  label,
  isExpanded,
  onToggle,
  isAnyChildActive,
  collapsed = false,
  children,
}: NavParentGroupProps) {
  const [hovered, setHovered] = useState(false);
  const showActive = collapsed && isAnyChildActive;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginTop: '8px' }}>
        <button
          type="button"
          onClick={onToggle}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          title={collapsed ? label : undefined}
          aria-label={collapsed ? label : undefined}
          aria-expanded={collapsed ? undefined : isExpanded}
          style={navGroupHeaderStyle({ collapsed, active: showActive, hovered })}
        >
          {!collapsed && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '16px',
                height: '16px',
                flexShrink: 0,
                transition: 'transform 150ms ease-in-out',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              }}
            >
              ▶
            </span>
          )}
          <NavIcon name={parent.icon} />
          {!collapsed && label}
        </button>
      </div>
      {!collapsed && isExpanded && <div>{children}</div>}
    </div>
  );
}
