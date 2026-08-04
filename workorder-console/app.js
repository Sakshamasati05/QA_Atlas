// Mock Data initialization
const INITIAL_WORKORDERS = [
  {
    id: "WO-1046",
    title: "wdewdede",
    status: "Cancelled",
    creator: "Alex Morgan",
    date: "Jun 1, 2026",
    reviewedBy: "Alex Morgan",
    qaPassed: "Yes",
    rejectionReason: "",
    groups: [
      {
        name: "desddwe",
        items: [
          { name: "scscs", category: "String" },
          { name: "scsc", category: "Numeric" },
          { name: "cscsc", category: "Image" },
          { name: "cscscs", category: "Single Select" },
          { name: "cdcdc", category: "Date" },
          { name: "cdcdc", category: "Label Code" }
        ]
      }
    ]
  },
  {
    id: "WO-1047",
    title: "sccedv3e",
    status: "Not Approved",
    creator: "Alex Morgan",
    date: "Jun 1, 2026",
    reviewedBy: "Alex Morgan",
    qaPassed: "Yes",
    rejectionReason: "dvdvd",
    groups: [
      {
        name: "cedcedv",
        items: [
          { name: "dvdvdv", category: "String" }
        ]
      }
    ]
  }
];

// App State Management
let workorders = [];
let currentWoId = null;
let currentGroupIdx = 0;
let isEditMode = false;
let currentFilter = "all";
let searchKeyword = "";

// Initialize State
function initApp() {
  const stored = localStorage.getItem("workorders");
  if (stored) {
    try {
      workorders = JSON.parse(stored);
    } catch (e) {
      console.error("Error parsing stored workorders, resetting to defaults", e);
      workorders = [...INITIAL_WORKORDERS];
      saveStateToLocalStorage();
    }
  } else {
    workorders = [...INITIAL_WORKORDERS];
    saveStateToLocalStorage();
  }

  setupEventListeners();
  renderDashboard();
}

function saveStateToLocalStorage() {
  localStorage.setItem("workorders", JSON.stringify(workorders));
}

// Toast Notifications Helper
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let icon = "";
  if (type === "success") {
    icon = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  } else if (type === "error") {
    icon = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else {
    icon = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.5" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);

  // Automatically remove toast after 3s
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Routing & View Switches
function showView(viewId) {
  document.querySelectorAll(".view-section").forEach(view => {
    view.classList.add("hidden");
  });
  document.getElementById(viewId).classList.remove("hidden");
  
  if (viewId === "dashboard-view") {
    // Reset selection state
    currentWoId = null;
    currentGroupIdx = 0;
    isEditMode = false;
    document.getElementById("edit-mode-toggle").checked = false;
    document.getElementById("nav-workorders-btn").classList.add("active");
    renderDashboard();
  } else {
    document.getElementById("nav-workorders-btn").classList.remove("active");
  }
}

// -------------------------------------------------------------
// DASHBOARD RENDERING & CONTROLS
// -------------------------------------------------------------

function renderDashboard() {
  const tbody = document.getElementById("workorders-list-body");
  const emptyState = document.getElementById("wo-empty-state");
  tbody.innerHTML = "";

  // Calculate statistics
  let totalCount = workorders.length;
  let approvedCount = workorders.filter(w => w.status === "Approved").length;
  let notApprovedCount = workorders.filter(w => w.status === "Not Approved").length;
  let cancelledCount = workorders.filter(w => w.status === "Cancelled").length;

  document.getElementById("stat-total").textContent = totalCount;
  document.getElementById("stat-approved").textContent = approvedCount;
  document.getElementById("stat-not-approved").textContent = notApprovedCount;
  document.getElementById("stat-cancelled").textContent = cancelledCount;

  // Filter and Search logic
  const filtered = workorders.filter(wo => {
    const matchesStatus = (currentFilter === "all") || (wo.status === currentFilter);
    const matchesSearch = wo.id.toLowerCase().includes(searchKeyword.toLowerCase()) || 
                          wo.title.toLowerCase().includes(searchKeyword.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  if (filtered.length === 0) {
    emptyState.classList.remove("hidden");
  } else {
    emptyState.classList.add("hidden");
    
    filtered.forEach(wo => {
      const tr = document.createElement("tr");
      
      // Calculate group and item counts
      const groupsCount = wo.groups.length;
      
      // Status Badge CSS
      let badgeClass = "status-badge-grey";
      if (wo.status === "Approved") badgeClass = "status-badge-approved";
      if (wo.status === "Not Approved") badgeClass = "status-badge-rejected";
      if (wo.status === "Cancelled") badgeClass = "status-badge-cancelled";
      if (wo.status === "Pending") badgeClass = "status-badge-pending";

      tr.innerHTML = `
        <td><a class="wo-id-link" data-id="${wo.id}">${wo.id}</a></td>
        <td><strong style="color: var(--primary);">${escapeHTML(wo.title)}</strong></td>
        <td>
          <span class="status-dot-badge ${badgeClass}">
            <span class="dot">•</span> <span class="text">${escapeHTML(wo.status)}</span>
          </span>
        </td>
        <td>${escapeHTML(wo.qaPassed)}</td>
        <td class="creator-cell">${escapeHTML(wo.creator)}</td>
        <td class="date-cell">${escapeHTML(wo.date)}</td>
        <td><span class="font-medium">${groupsCount}</span> groups</td>
        <td>
          <button class="btn btn-secondary btn-sm inspect-wo-btn" data-id="${wo.id}">
            Inspect
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// -------------------------------------------------------------
// DETAIL VIEW RENDERING
// -------------------------------------------------------------

function renderDetailView(woId) {
  const wo = workorders.find(w => w.id === woId);
  if (!wo) {
    showToast("Workorder not found!", "error");
    showView("dashboard-view");
    return;
  }

  currentWoId = woId;
  
  // Set Breadcrumbs
  document.getElementById("crumb-id").textContent = wo.id;
  document.getElementById("crumb-title").textContent = wo.title;
  
  // Set Meta Header info
  document.getElementById("detail-wo-id").textContent = wo.id;
  document.getElementById("detail-wo-title").textContent = wo.title;
  document.getElementById("detail-wo-creator").textContent = `Created by ${wo.creator} · ${wo.date}`;

  // Update Main Header Status Badges
  const detailStatusBadge = document.getElementById("detail-status-badge");
  const detailOutcomeBadge = document.getElementById("detail-outcome-badge");
  
  updateBadgeColors(detailStatusBadge, wo.status);
  updateBadgeColors(detailOutcomeBadge, wo.status);

  // Edit Mode toggle label
  const editModeLabel = document.getElementById("edit-mode-label");
  if (isEditMode) {
    editModeLabel.textContent = "Interactive Editing";
    editModeLabel.style.color = "var(--accent)";
    editModeLabel.style.fontWeight = "600";
    document.getElementById("delete-wo-action-btn").classList.remove("hidden");
  } else {
    editModeLabel.textContent = "View only";
    editModeLabel.style.color = "#94A3B8";
    editModeLabel.style.fontWeight = "400";
    document.getElementById("delete-wo-action-btn").classList.add("hidden");
  }

  // Approval record details
  document.getElementById("detail-reviewed-by").textContent = wo.reviewedBy;
  document.getElementById("detail-qa-passed").textContent = wo.qaPassed;

  // Handle Rejection Reason display
  const rejectionCol = document.getElementById("rejection-reason-col");
  if (wo.status === "Not Approved") {
    rejectionCol.classList.remove("hidden");
    document.getElementById("detail-rejection-reason").textContent = wo.rejectionReason || "None specified";
  } else {
    rejectionCol.classList.add("hidden");
  }

  // Edit Mode visibility toggle
  const outcomeDisplay = document.getElementById("outcome-display-container");
  const outcomeEdit = document.getElementById("outcome-edit-container");
  const reviewedByDisplay = document.getElementById("detail-reviewed-by");
  const reviewedByEdit = document.getElementById("reviewed-by-edit-container");
  const qaPassedDisplay = document.getElementById("detail-qa-passed");
  const qaPassedEdit = document.getElementById("qa-passed-edit-container");
  const rejectionDisplay = document.getElementById("detail-rejection-reason");
  const rejectionEdit = document.getElementById("rejection-reason-edit-container");

  if (isEditMode) {
    outcomeDisplay.classList.add("hidden");
    outcomeEdit.classList.remove("hidden");
    reviewedByDisplay.classList.add("hidden");
    reviewedByEdit.classList.remove("hidden");
    qaPassedDisplay.classList.add("hidden");
    qaPassedEdit.classList.remove("hidden");
    
    document.getElementById("edit-outcome-select").value = wo.status;
    document.getElementById("edit-reviewed-by-input").value = wo.reviewedBy;
    document.getElementById("edit-qa-passed-select").value = wo.qaPassed;

    if (wo.status === "Not Approved") {
      rejectionDisplay.classList.add("hidden");
      rejectionEdit.classList.remove("hidden");
      document.getElementById("edit-rejection-reason-input").value = wo.rejectionReason;
    } else {
      rejectionEdit.classList.add("hidden");
    }

    // Show add triggers
    document.getElementById("add-group-trigger").classList.remove("hidden");
    document.getElementById("add-item-trigger").classList.remove("hidden");
  } else {
    outcomeDisplay.classList.remove("hidden");
    outcomeEdit.classList.add("hidden");
    reviewedByDisplay.classList.remove("hidden");
    reviewedByEdit.classList.add("hidden");
    qaPassedDisplay.classList.remove("hidden");
    qaPassedEdit.classList.add("hidden");
    rejectionDisplay.classList.remove("hidden");
    rejectionEdit.classList.add("hidden");

    // Hide add triggers
    document.getElementById("add-group-trigger").classList.add("hidden");
    document.getElementById("add-item-trigger").classList.add("hidden");
  }

  // Groups and Items section
  renderGroupsList(wo);
  renderGroupItems(wo);
}

function updateBadgeColors(badgeEl, status) {
  badgeEl.className = "status-dot-badge";
  let badgeClass = "status-badge-grey";
  if (status === "Approved") badgeClass = "status-badge-approved";
  if (status === "Not Approved") badgeClass = "status-badge-rejected";
  if (status === "Cancelled") badgeClass = "status-badge-cancelled";
  if (status === "Pending") badgeClass = "status-badge-pending";
  
  badgeEl.classList.add(badgeClass);
  badgeEl.querySelector(".text").textContent = status;
}

// Renders Groups in sidebar (left side of detail split layout)
function renderGroupsList(wo) {
  const container = document.getElementById("groups-list-container");
  container.innerHTML = "";
  
  document.getElementById("groups-count-summary").textContent = `${wo.groups.length} total`;
  
  if (wo.groups.length === 0) {
    container.innerHTML = `<li class="group-item" style="cursor:default; text-align:center;">No groups</li>`;
    return;
  }

  // Double check out of bounds
  if (currentGroupIdx >= wo.groups.length) {
    currentGroupIdx = 0;
  }

  wo.groups.forEach((group, idx) => {
    const li = document.createElement("li");
    li.className = `group-item ${idx === currentGroupIdx ? "active" : ""}`;
    li.dataset.idx = idx;

    li.innerHTML = `
      <div class="group-item-left">
        <span class="group-idx">${idx + 1}</span>
        <span class="group-name font-medium">${escapeHTML(group.name)}</span>
      </div>
      <span class="group-count">${group.items.length}</span>
    `;

    li.addEventListener("click", () => {
      currentGroupIdx = idx;
      renderDetailView(wo.id);
    });

    container.appendChild(li);
  });
}

// Renders list of items belonging to selected group (right side of detail split layout)
function renderGroupItems(wo) {
  const tbody = document.getElementById("items-table-body");
  const emptyState = document.getElementById("items-empty-state");
  const group = wo.groups[currentGroupIdx];
  
  tbody.innerHTML = "";

  // Path Crumbs on right card header
  document.getElementById("group-crumb-wo").textContent = wo.id;
  if (group) {
    document.getElementById("group-crumb-group").textContent = group.name;
    document.getElementById("items-count-heading").textContent = `${group.items.length} items in this group`;
  } else {
    document.getElementById("group-crumb-group").textContent = "--";
    document.getElementById("items-count-heading").textContent = "0 items in this group";
  }

  if (!group || group.items.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");

  group.items.forEach((item, idx) => {
    const tr = document.createElement("tr");

    // Category Badging
    let catClass = "cat-badge";
    const cleanCat = item.category.toLowerCase().replace(" ", "-");
    catClass += ` cat-badge-${cleanCat}`;

    // Action column HTML: if View-only render '--', if Edit render edit/delete actions
    let actionHTML = `<span class="item-action-static">--</span>`;
    if (isEditMode) {
      actionHTML = `
        <div class="item-actions-group">
          <button class="btn-item-action edit-item" data-idx="${idx}" title="Edit Item">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="btn-item-action delete-item" data-idx="${idx}" title="Delete Item">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>
        </div>
      `;
    }

    tr.innerHTML = `
      <td class="date-cell">${idx + 1}</td>
      <td><strong>${escapeHTML(item.name)}</strong></td>
      <td>
        <span class="${catClass}">${escapeHTML(item.category)}</span>
      </td>
      <td class="text-right">${actionHTML}</td>
    `;

    // Hook events inside editing mode
    if (isEditMode) {
      tr.querySelector(".edit-item").addEventListener("click", () => {
        openItemModal(idx);
      });
      tr.querySelector(".delete-item").addEventListener("click", () => {
        deleteItem(idx);
      });
    }

    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------
// EVENT LISTENERS & STATE ACTIONS
// -------------------------------------------------------------

function setupEventListeners() {
  // Navigation / Title Clicks
  document.getElementById("nav-workorders-btn").addEventListener("click", (e) => {
    e.preventDefault();
    showView("dashboard-view");
  });
  document.getElementById("detail-back-btn").addEventListener("click", () => {
    showView("dashboard-view");
  });
  document.getElementById("crumb-root").addEventListener("click", () => {
    showView("dashboard-view");
  });

  // Table clicks on IDs
  document.getElementById("workorders-list-body").addEventListener("click", (e) => {
    const target = e.target;
    if (target.classList.contains("wo-id-link") || target.classList.contains("inspect-wo-btn")) {
      const woId = target.dataset.id;
      showView("detail-view");
      renderDetailView(woId);
    }
  });

  // Search filter
  document.getElementById("wo-search").addEventListener("input", (e) => {
    searchKeyword = e.target.value;
    renderDashboard();
  });

  // Status Filter clicks
  document.getElementById("status-filters").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") {
      document.querySelectorAll("#status-filters button").forEach(btn => btn.classList.remove("active"));
      e.target.classList.add("active");
      currentFilter = e.target.dataset.filter;
      renderDashboard();
    }
  });

  // Click on Stat Cards triggers filter
  document.querySelectorAll(".stat-card").forEach(card => {
    card.addEventListener("click", () => {
      const filterVal = card.dataset.filter;
      currentFilter = filterVal;
      
      // Update filters active class
      document.querySelectorAll("#status-filters button").forEach(btn => {
        if (btn.dataset.filter === filterVal) {
          btn.classList.add("active");
        } else {
          btn.classList.remove("active");
        }
      });
      renderDashboard();
    });
  });

  // Info icon button
  document.getElementById("info-btn").addEventListener("click", () => {
    showToast("Operations Console version 1.2.0. Loaded 100% locally.", "info");
  });

  // Logout button mockup
  document.getElementById("logout-btn").addEventListener("click", () => {
    showToast("Logout requested. App runs in local standalone session.", "info");
  });

  // Edit Mode Switch listener
  document.getElementById("edit-mode-toggle").addEventListener("change", (e) => {
    isEditMode = e.target.checked;
    renderDetailView(currentWoId);
    if (isEditMode) {
      showToast("Interactive editing mode activated.", "info");
    } else {
      showToast("Returned to View-Only mode.", "info");
    }
  });

  // Approval card inline changes (triggers immediately and saves)
  document.getElementById("edit-outcome-select").addEventListener("change", (e) => {
    const wo = workorders.find(w => w.id === currentWoId);
    if (wo) {
      wo.status = e.target.value;
      if (wo.status !== "Not Approved") {
        wo.rejectionReason = "";
      }
      saveStateToLocalStorage();
      renderDetailView(currentWoId);
      showToast(`Outcome status updated to "${wo.status}".`);
    }
  });

  document.getElementById("edit-reviewed-by-input").addEventListener("blur", (e) => {
    const wo = workorders.find(w => w.id === currentWoId);
    if (wo && wo.reviewedBy !== e.target.value) {
      wo.reviewedBy = e.target.value;
      saveStateToLocalStorage();
      renderDetailView(currentWoId);
      showToast("Reviewed By updated.");
    }
  });

  document.getElementById("edit-qa-passed-select").addEventListener("change", (e) => {
    const wo = workorders.find(w => w.id === currentWoId);
    if (wo) {
      wo.qaPassed = e.target.value;
      saveStateToLocalStorage();
      renderDetailView(currentWoId);
      showToast(`QA Passed status updated to "${wo.qaPassed}".`);
    }
  });

  document.getElementById("edit-rejection-reason-input").addEventListener("blur", (e) => {
    const wo = workorders.find(w => w.id === currentWoId);
    if (wo && wo.rejectionReason !== e.target.value) {
      wo.rejectionReason = e.target.value;
      saveStateToLocalStorage();
      renderDetailView(currentWoId);
      showToast("Rejection Reason updated.");
    }
  });

  // Delete Workorder action button
  document.getElementById("delete-wo-action-btn").addEventListener("click", () => {
    if (confirm(`Are you sure you want to delete this workorder (${currentWoId})?`)) {
      workorders = workorders.filter(w => w.id !== currentWoId);
      saveStateToLocalStorage();
      showToast(`Deleted workorder template ${currentWoId}.`);
      showView("dashboard-view");
    }
  });

  // Modals closing events
  document.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeAllModals();
    });
  });

  // Click on backdrop shuts modal
  document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        closeAllModals();
      }
    });
  });

  // CREATE WORKORDER SUBMISSION
  document.getElementById("create-wo-btn").addEventListener("click", () => {
    // Reset form & Open Modal
    document.getElementById("create-wo-form").reset();
    document.getElementById("modal-rejection-group").style.display = "none";
    document.getElementById("create-wo-modal").classList.remove("hidden");
  });

  document.getElementById("new-wo-outcome").addEventListener("change", (e) => {
    const isRejected = e.target.value === "Not Approved";
    document.getElementById("modal-rejection-group").style.display = isRejected ? "flex" : "none";
  });

  document.getElementById("create-wo-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("new-wo-id").value.trim().toUpperCase();
    const title = document.getElementById("new-wo-title").value.trim();
    const status = document.getElementById("new-wo-outcome").value;
    const reviewer = document.getElementById("new-wo-reviewer").value.trim();
    const qa = document.getElementById("new-wo-qa").value;
    const rejection = document.getElementById("new-wo-rejection").value.trim();

    // Check duplicate ID
    if (workorders.some(w => w.id === id)) {
      showToast(`Workorder ID ${id} already exists. Please choose another!`, "error");
      return;
    }

    const newWo = {
      id,
      title,
      status,
      creator: "Alex Morgan",
      date: formatDate(new Date()),
      reviewedBy: reviewer,
      qaPassed: qa,
      rejectionReason: status === "Not Approved" ? rejection : "",
      groups: [
        {
          name: "default_group",
          items: [
            { name: "sample_record", category: "String" }
          ]
        }
      ]
    };

    workorders.push(newWo);
    saveStateToLocalStorage();
    closeAllModals();
    showToast(`Workorder template ${id} created.`);
    
    // Jump straight to inspecting the new card
    showView("detail-view");
    renderDetailView(id);
  });

  // ADD GROUP SUBMISSION
  document.getElementById("add-group-trigger").addEventListener("click", () => {
    document.getElementById("add-group-form").reset();
    document.getElementById("add-group-modal").classList.remove("hidden");
  });

  document.getElementById("add-group-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const groupName = document.getElementById("new-group-name").value.trim();
    const wo = workorders.find(w => w.id === currentWoId);
    
    if (wo) {
      if (wo.groups.some(g => g.name.toLowerCase() === groupName.toLowerCase())) {
        showToast("A group with that name already exists!", "error");
        return;
      }

      wo.groups.push({
        name: groupName,
        items: []
      });
      saveStateToLocalStorage();
      closeAllModals();
      showToast(`Group "${groupName}" added successfully.`);
      
      // Select the newly added group
      currentGroupIdx = wo.groups.length - 1;
      renderDetailView(currentWoId);
    }
  });

  // ADD/EDIT ITEM SUBMISSION
  document.getElementById("add-item-trigger").addEventListener("click", () => {
    openItemModal();
  });

  document.getElementById("item-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("item-name-input").value.trim();
    const category = document.getElementById("item-category-select").value;
    const editIndexVal = document.getElementById("item-edit-index").value;
    
    const wo = workorders.find(w => w.id === currentWoId);
    if (!wo || !wo.groups[currentGroupIdx]) return;

    const group = wo.groups[currentGroupIdx];

    if (editIndexVal === "") {
      // Create new Item
      group.items.push({ name, category });
      showToast(`Item "${name}" added to "${group.name}".`);
    } else {
      // Edit existing Item
      const idx = parseInt(editIndexVal);
      if (group.items[idx]) {
        group.items[idx].name = name;
        group.items[idx].category = category;
        showToast(`Item details updated.`);
      }
    }

    saveStateToLocalStorage();
    closeAllModals();
    renderDetailView(currentWoId);
  });
}

function openItemModal(itemIndex = null) {
  const modal = document.getElementById("item-modal");
  const form = document.getElementById("item-form");
  const modalTitle = document.getElementById("item-modal-title");
  const submitBtn = document.getElementById("item-modal-submit-btn");

  form.reset();

  if (itemIndex === null) {
    modalTitle.textContent = "Add New Item";
    submitBtn.textContent = "Add Item";
    document.getElementById("item-edit-index").value = "";
  } else {
    modalTitle.textContent = "Edit Item details";
    submitBtn.textContent = "Save Changes";
    document.getElementById("item-edit-index").value = itemIndex;

    const wo = workorders.find(w => w.id === currentWoId);
    const item = wo.groups[currentGroupIdx].items[itemIndex];
    if (item) {
      document.getElementById("item-name-input").value = item.name;
      document.getElementById("item-category-select").value = item.category;
    }
  }

  modal.classList.remove("hidden");
}

function deleteItem(itemIndex) {
  const wo = workorders.find(w => w.id === currentWoId);
  if (!wo || !wo.groups[currentGroupIdx]) return;

  const group = wo.groups[currentGroupIdx];
  const itemName = group.items[itemIndex].name;
  
  if (confirm(`Remove item "${itemName}"?`)) {
    group.items.splice(itemIndex, 1);
    saveStateToLocalStorage();
    renderDetailView(currentWoId);
    showToast(`Removed item "${itemName}".`);
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.add("hidden"));
}

// -------------------------------------------------------------
// UTILITIES
// -------------------------------------------------------------

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function formatDate(date) {
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  return date.toLocaleDateString('en-US', options);
}

// Kickstart
document.addEventListener("DOMContentLoaded", initApp);
