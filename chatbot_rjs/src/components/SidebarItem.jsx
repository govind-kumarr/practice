import React from "react";
import { useNavigate } from "react-router-dom";

const SidebarItem = ({ icon, text, badge, link }) => {
  const navigate = useNavigate();
  return (
    <li onClick={() => navigate(link)}>
      <a
        href="#"
        className="flex items-center p-2 text-gray-900 rounded-lg dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700 group"
      >
        {icon}
        <span className="flex-1 ms-3 whitespace-nowrap">{text}</span>
        {badge && (
          <span className="inline-flex items-center justify-center w-3 h-3 p-3 ms-3 text-sm font-medium text-blue-800 bg-blue-100 rounded-full dark:bg-blue-900 dark:text-blue-300">
            {badge}
          </span>
        )}
      </a>
    </li>
  );
};

export default SidebarItem;
