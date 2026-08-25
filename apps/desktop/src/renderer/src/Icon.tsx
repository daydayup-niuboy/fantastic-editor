import type { SVGProps } from "react";

export type IconName = "chevronDown" | "columns" | "download" | "eye" | "file" | "filePlus" | "folder" | "folderOpen" | "imagePlus" | "markdown" | "moon" | "panelLeft" | "save" | "scrollSync" | "sun";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const content = {
    chevronDown: <path d="m7 10 5 5 5-5" />,
    columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
    file: <><path d="M6 2.75h8l4 4V21H6z" /><path d="M14 2.75V7h4" /></>,
    filePlus: <><path d="M6 2.75h8l4 4V21H6z" /><path d="M14 2.75V7h4" /><path d="M12 11v6M9 14h6" /></>,
    folder: <path d="M3 6.5h7l2-2h9v15H3z" />,
    folderOpen: <><path d="M3 7h7l2-2h8v4" /><path d="m4 20 2.2-9h16L20 20z" /></>,
    imagePlus: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5 17 4.5-4 3.2 3 2.3-2 4 3.5M18 5v6M15 8h6" /></>,
    markdown: <><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M6 15v-6l3 3 3-3v6M15 12h3M16.5 10.5V15" /></>,
    moon: <path d="M20.4 15.1A8 8 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z" />,
    panelLeft: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    save: <><path d="M5 3h12l3 3v15H4V3z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></>,
    scrollSync: <><path d="M7 4v12" /><path d="m4 13 3 3 3-3" /><path d="M17 20V8" /><path d="m14 11 3-3 3 3" /></>,
    sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  }[name];

  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>{content}</svg>;
}

