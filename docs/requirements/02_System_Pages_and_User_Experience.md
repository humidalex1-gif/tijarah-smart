# Smart Inventory & Financial System
## File 02 — System Pages & User Experience

**Suggested project name:** Tijarah Smart  
**Document version:** 1.0  
**Purpose:** Define every major page, screen, section, button, table, filter, workflow, and user interaction in the platform.

---

# 1. User Experience Principles

The system should feel simple, fast, and clear for merchants who are not accountants or technical users.

Core UX principles:

- Use clear language instead of accounting jargon.
- Show important numbers first.
- Allow users to click any total to see the detailed calculation.
- Use consistent buttons, tables, and forms across all modules.
- Reduce the number of steps required for daily tasks.
- Show confirmation before sensitive actions.
- Make Arabic fully RTL and English fully LTR.
- Use responsive layouts for desktop, tablet, and mobile.
- Keep the most common actions visible.
- Use search, filters, and saved views on all major tables.
- Never hide important financial or inventory impacts.
- Always show status clearly using labels and colors.
- Provide empty-state guidance when no data exists.

---

# 2. Global Application Layout

## 2.1 Desktop Layout

The desktop interface should contain:

- Left sidebar navigation
- Top header
- Main content area
- Optional right-side quick panel
- Notification center
- Global search
- User menu
- Company switcher

## 2.2 Sidebar

Sidebar items:

1. Dashboard
2. Products
3. Inventory
4. Warehouses
5. Purchases
6. Suppliers
7. Sales
8. Customers
9. Expenses
10. Advertising
11. Finance
12. Reports
13. Integrations
14. AI Assistant
15. Notifications
16. Users and Permissions
17. Settings

Sidebar behavior:

- Collapsible
- Icons with labels
- Current page highlighted
- Nested menus for detailed sections
- Badge for pending actions
- Badge for low-stock alerts
- Full RTL support
- Mobile version becomes a slide-out drawer

## 2.3 Top Header

The top header should include:

- Global search
- Date range selector
- Current company
- Current branch
- Current warehouse
- Quick add button
- Notifications icon
- Help icon
- Language switcher
- Dark mode toggle
- User profile menu

## 2.4 Global Search

Global search should find:

- Products
- SKUs
- Barcodes
- Customers
- Suppliers
- Sales orders
- Invoices
- Purchase orders
- Expenses
- Warehouse transfers
- Reports

Search results should be grouped by category and show quick actions.

## 2.5 Quick Add Menu

The quick add button should allow:

- Add product
- Receive stock
- Create sale
- Create purchase order
- Add expense
- Add customer
- Add supplier
- Transfer stock
- Create invoice

---

# 3. Authentication Pages

## 3.1 Login Page

Fields:

- Email
- Password
- Remember me

Actions:

- Sign in
- Forgot password
- Create account
- Sign in with Google
- Sign in with Microsoft

Design:

- Clean centered card
- Company logo
- Language selector
- Security notice
- Optional product screenshot

## 3.2 Create Account Page

Fields:

- Full name
- Business name
- Email
- Phone
- Password
- Confirm password
- Country
- Preferred language
- Business type

Actions:

- Create account
- Accept terms
- Sign in instead

## 3.3 Forgot Password Page

Fields:

- Email

Actions:

- Send reset link
- Return to login

## 3.4 Two-Factor Authentication Page

Fields:

- Verification code

Actions:

- Verify
- Resend code
- Use backup code

---

# 4. Company Onboarding

The onboarding process should be simple and step-by-step.

## Step 1: Company Information

Fields:

- Company name
- Legal name
- Logo
- Phone
- Email
- Website
- Country
- City
- Address
- Tax number
- Commercial registration number

## Step 2: Business Setup

Fields:

- Business type
- Main sales channel
- Number of warehouses
- Number of branches
- Number of products
- Number of employees

## Step 3: Financial Setup

Fields:

- Main currency
- Tax system
- Default tax rate
- Financial year start
- Opening cash balance
- Opening bank balance

## Step 4: Inventory Setup

Fields:

- Inventory valuation method
- Allow negative inventory
- Enable batch tracking
- Enable expiry dates
- Enable serial numbers
- Default reorder rule

## Step 5: Add Initial Data

Options:

- Add products manually
- Import products from Excel
- Connect Salla
- Skip for now

## Step 6: Invite Team

Fields:

- Name
- Email
- Role

## Completion Screen

Display:

- Setup completed
- Recommended next steps
- Go to dashboard
- Add first product
- Connect store
- Add warehouse

---

# 5. Dashboard Page

## 5.1 Main KPI Cards

Cards:

- Sales today
- Sales this month
- Gross profit
- Net profit
- Total expenses
- Inventory value
- Cash balance
- Amount due from customers
- Amount due to suppliers
- Low-stock items

Each card should show:

- Current value
- Percentage change
- Comparison period
- Mini chart
- Click to view details

## 5.2 Sales and Profit Chart

Features:

- Daily, weekly, monthly view
- Revenue line
- Gross profit line
- Net profit line
- Compare with previous period
- Hover details
- Export chart

## 5.3 Inventory Summary

Show:

- Total units
- Total SKUs
- Available stock
- Reserved stock
- Damaged stock
- Out-of-stock products
- Low-stock products
- Inventory value

## 5.4 Best Performing Products

Table columns:

- Product
- Units sold
- Revenue
- Gross profit
- Net profit
- Profit margin
- Trend

## 5.5 Products Requiring Attention

Sections:

- Low stock
- Out of stock
- Slow-moving
- Negative profit
- High return rate
- Expiring soon

## 5.6 Cash Flow Summary

Show:

- Cash inflow
- Cash outflow
- Net cash flow
- Current cash
- Current bank balance
- Upcoming payments

## 5.7 Pending Actions

Examples:

- Purchase orders awaiting approval
- Transfers awaiting receipt
- Supplier payments due
- Customer payments overdue
- Unreviewed expenses
- Integration sync errors

## 5.8 Dashboard Controls

Controls:

- Date range
- Branch
- Warehouse
- Sales channel
- Currency
- Save dashboard view
- Customize widgets

---

# 6. Products Page

## 6.1 Products List

Columns:

- Product image
- Product name
- SKU
- Barcode
- Category
- Brand
- Available stock
- Reserved stock
- Average cost
- Selling price
- Profit margin
- Status
- Last updated

Filters:

- Category
- Brand
- Supplier
- Warehouse
- Stock status
- Product status
- Profitability
- Date created

Actions:

- Add product
- Import Excel
- Export
- Bulk edit
- Print labels
- Archive
- Duplicate
- Delete or deactivate

## 6.2 Add Product Page

Sections:

### Basic Information

- Arabic name
- English name
- SKU
- Barcode
- Category
- Brand
- Description
- Product images

### Product Type

- Simple product
- Variant product
- Bundle
- Kit
- Raw material
- Finished product
- Service

### Pricing

- Purchase price
- Selling price
- Wholesale price
- Minimum selling price
- Tax
- Currency

### Inventory

- Opening quantity
- Warehouse
- Reorder level
- Reorder quantity
- Track stock
- Allow backorders

### Physical Details

- Weight
- Length
- Width
- Height
- Unit of measurement

### Tracking

- Batch number
- Expiry date
- Serial number
- Lot number

### Supplier

- Default supplier
- Supplier SKU
- Supplier price
- Lead time

Buttons:

- Save
- Save and add another
- Save as draft
- Cancel

## 6.3 Product Details Page

Tabs:

1. Overview
2. Inventory
3. Purchases
4. Sales
5. Expenses
6. Profitability
7. Warehouses
8. History
9. Attachments

Overview should show:

- Product image
- Product name
- SKU
- Barcode
- Status
- Current stock
- Inventory value
- Selling price
- Average cost
- Gross margin
- Net margin
- Reorder status

Quick actions:

- Edit
- Receive stock
- Sell
- Transfer
- Adjust stock
- Print barcode
- Archive

## 6.4 Product Variants

Variant table:

- Variant name
- SKU
- Barcode
- Color
- Size
- Cost
- Price
- Stock
- Status

Actions:

- Add variant
- Generate variants
- Bulk edit
- Import variants

---

# 7. Inventory Page

## 7.1 Inventory Overview

Show:

- Total inventory units
- Total inventory value
- Available stock
- Reserved stock
- Damaged stock
- In-transit stock
- Low-stock count
- Out-of-stock count

## 7.2 Inventory Table

Columns:

- Product
- SKU
- Warehouse
- Available
- Reserved
- In transit
- Damaged
- Reorder level
- Inventory value
- Status

Filters:

- Warehouse
- Category
- Brand
- Stock status
- Supplier
- Product type

Actions:

- Receive stock
- Issue stock
- Transfer
- Adjust
- Count stock
- Export
- Print report

## 7.3 Stock Movement History

Columns:

- Date and time
- Product
- Movement type
- Quantity
- Source
- Destination
- Reference
- User
- Cost impact

Filters:

- Date
- Product
- Movement type
- Warehouse
- User
- Reference number

## 7.4 Receive Stock Page

Fields:

- Supplier
- Purchase order
- Receiving warehouse
- Receiving date
- Reference number
- Products
- Ordered quantity
- Received quantity
- Damaged quantity
- Batch number
- Expiry date
- Notes
- Attachments

Actions:

- Save draft
- Confirm receipt
- Print receiving note

## 7.5 Issue Stock Page

Fields:

- Warehouse
- Product
- Quantity
- Reason
- Destination
- Date
- Notes

Reasons:

- Internal use
- Promotion
- Sample
- Damage
- Loss
- Manual issue

## 7.6 Stock Adjustment Page

Fields:

- Warehouse
- Product
- Current quantity
- New quantity
- Difference
- Reason
- Notes
- Attachment

Sensitive adjustments should require approval.

## 7.7 Stock Count Page

Modes:

- Full count
- Cycle count
- Category count
- Shelf count

Columns:

- Product
- System quantity
- Counted quantity
- Difference
- Difference value
- Reason

Actions:

- Save draft
- Submit count
- Approve adjustment
- Export count sheet

---

# 8. Warehouses Page

## 8.1 Warehouses List

Columns:

- Warehouse name
- Code
- Location
- Manager
- Total SKUs
- Total units
- Inventory value
- Status

Actions:

- Add warehouse
- Edit
- View
- Deactivate

## 8.2 Warehouse Details

Tabs:

- Overview
- Inventory
- Movements
- Transfers
- Stock counts
- Staff
- Settings

Overview cards:

- Inventory value
- Total units
- Low stock
- Damaged stock
- Pending transfers

## 8.3 Warehouse Transfer Page

Fields:

- Source warehouse
- Destination warehouse
- Transfer date
- Expected arrival
- Products
- Quantities
- Notes
- Shipping reference

Statuses:

- Draft
- Awaiting approval
- Approved
- In transit
- Partially received
- Received
- Canceled

Actions:

- Submit
- Approve
- Ship
- Receive
- Cancel
- Print transfer document

---

# 9. Purchases Page

## 9.1 Purchase Orders List

Columns:

- PO number
- Supplier
- Order date
- Expected date
- Total
- Payment status
- Receiving status
- Approval status

Filters:

- Supplier
- Status
- Date
- Warehouse
- Payment status

Actions:

- New purchase order
- Export
- Duplicate
- Cancel

## 9.2 Create Purchase Order

Sections:

### Supplier Information

- Supplier
- Contact person
- Currency
- Payment terms

### Products

- Product
- SKU
- Quantity
- Unit cost
- Discount
- Tax
- Line total

### Additional Costs

- International shipping
- Local shipping
- Customs
- Insurance
- Handling
- Inspection
- Storage
- Other costs

### Allocation Method

- By quantity
- By weight
- By volume
- By value
- Equal
- Manual

### Summary

- Subtotal
- Discount
- Tax
- Additional costs
- Grand total
- Expected landed cost

Actions:

- Save draft
- Submit for approval
- Approve
- Send to supplier
- Print PDF

## 9.3 Purchase Order Details

Tabs:

- Overview
- Items
- Receiving
- Payments
- Landed cost
- Documents
- History

Quick actions:

- Receive stock
- Add payment
- Edit
- Duplicate
- Cancel
- Print

---

# 10. Suppliers Page

## 10.1 Suppliers List

Columns:

- Supplier name
- Country
- Phone
- Email
- Balance
- Total purchases
- Last order
- Rating
- Status

Actions:

- Add supplier
- Import
- Export
- Deactivate

## 10.2 Supplier Details

Tabs:

- Overview
- Purchase orders
- Invoices
- Payments
- Products
- Statement
- Documents
- Notes

Overview:

- Total purchases
- Amount paid
- Outstanding balance
- Average lead time
- On-time delivery rate
- Return rate

---

# 11. Sales Page

## 11.1 Sales Orders List

Columns:

- Order number
- Customer
- Channel
- Date
- Total
- Payment status
- Fulfillment status
- Net profit
- Warehouse

Filters:

- Date
- Channel
- Customer
- Payment status
- Fulfillment status
- Warehouse

Actions:

- New sale
- Export
- Print
- Create invoice

## 11.2 Create Sale Page

Sections:

### Customer

- Customer
- Phone
- Address
- Customer type

### Products

- Product
- Variant
- Available stock
- Quantity
- Selling price
- Discount
- Tax
- Total

### Order Costs

- Shipping charged to customer
- Actual shipping cost
- Platform fee
- Payment gateway fee
- Sales commission
- Advertising allocation

### Payment

- Payment method
- Paid amount
- Remaining amount
- Due date
- Account receiving payment

### Fulfillment

- Warehouse
- Delivery method
- Shipping company
- Tracking number

Summary:

- Revenue
- Product cost
- Gross profit
- Additional costs
- Net profit
- Profit margin

Actions:

- Save draft
- Confirm sale
- Confirm and print invoice
- Send invoice
- Cancel

## 11.3 Sale Details Page

Tabs:

- Overview
- Products
- Payments
- Shipment
- Returns
- Profitability
- History

Quick actions:

- Record payment
- Ship order
- Create return
- Refund
- Print invoice
- Send via WhatsApp
- Cancel order

## 11.4 Returns Page

Fields:

- Original order
- Customer
- Product
- Quantity
- Return reason
- Product condition
- Refund amount
- Return to stock
- Warehouse
- Notes

Product condition:

- Sellable
- Damaged
- Opened
- Missing parts
- Expired

---

# 12. Customers Page

## 12.1 Customers List

Columns:

- Customer
- Phone
- Email
- Type
- Total orders
- Total sales
- Outstanding balance
- Last order
- Status

Filters:

- Retail
- Wholesale
- Has outstanding balance
- High value
- Inactive

## 12.2 Customer Details

Tabs:

- Overview
- Orders
- Invoices
- Payments
- Returns
- Statement
- Profitability
- Notes

Overview:

- Total revenue
- Total paid
- Outstanding balance
- Total returns
- Net profit from customer
- Average order value
- Last purchase

---

# 13. Expenses Page

## 13.1 Expenses List

Columns:

- Expense number
- Date
- Expense name
- Category
- Amount
- Payment account
- Product or campaign
- Branch
- Status

Filters:

- Category
- Date
- Branch
- Warehouse
- Payment method
- Recurring
- Approval status

Actions:

- Add expense
- Import
- Export
- Approve
- Duplicate

## 13.2 Add Expense Page

Fields:

- Expense name
- Category
- Amount
- Currency
- Tax
- Date
- Payment account
- Supplier
- Product
- Campaign
- Warehouse
- Branch
- Recurring
- Notes
- Receipt attachment

Actions:

- Save
- Save and add another
- Submit for approval
- Cancel

## 13.3 Expense Details

Display:

- Full expense information
- Financial impact
- Related product
- Related campaign
- Approval history
- Receipt image
- Audit history

---

# 14. Advertising Page

## 14.1 Advertising Overview

Cards:

- Total ad spend
- Revenue attributed
- Orders
- ROAS
- Net profit after ads
- Cost per order
- Best campaign
- Worst campaign

## 14.2 Campaigns List

Columns:

- Campaign
- Platform
- Date range
- Spend
- Revenue
- Orders
- ROAS
- Net profit
- Status

Filters:

- Platform
- Product
- Date
- Performance
- Campaign status

## 14.3 Add Campaign

Fields:

- Campaign name
- Platform
- Start date
- End date
- Budget
- Actual spend
- Linked products
- Linked category
- Sales channel
- Attribution method
- Notes

## 14.4 Campaign Details

Tabs:

- Overview
- Spend
- Sales
- Products
- Profitability
- Daily performance
- Notes

Charts:

- Spend vs revenue
- Orders by day
- ROAS trend
- Net profit trend

---

# 15. Finance Page

## 15.1 Financial Overview

Cards:

- Cash
- Bank
- Digital wallets
- Accounts receivable
- Accounts payable
- Total income
- Total expenses
- Net cash flow
- Net profit

## 15.2 Accounts Page

Columns:

- Account name
- Account type
- Currency
- Current balance
- Last transaction
- Status

Account types:

- Cash
- Bank
- Wallet
- Sales income
- Expense
- Asset
- Liability
- Equity

## 15.3 Transactions Page

Columns:

- Date
- Transaction number
- Type
- Description
- Account
- Debit
- Credit
- Balance
- Reference

Filters:

- Account
- Date
- Type
- Amount
- Reference

## 15.4 Add Financial Transaction

Types:

- Income
- Expense
- Transfer
- Customer payment
- Supplier payment
- Refund
- Opening balance
- Manual journal

## 15.5 Profit and Loss Page

Sections:

- Revenue
- Cost of goods sold
- Gross profit
- Operating expenses
- Advertising
- Logistics
- Other income
- Other expenses
- Net profit

Features:

- Compare periods
- Expand every category
- Export
- Print
- View source transactions

## 15.6 Cash Flow Page

Sections:

- Operating inflow
- Operating outflow
- Investing activities
- Financing activities
- Net cash movement
- Closing cash balance

---

# 16. Reports Page

## 16.1 Reports Library

Categories:

- Inventory
- Sales
- Purchases
- Expenses
- Finance
- Profitability
- Customers
- Suppliers
- Advertising

Each report card should show:

- Report name
- Description
- Last opened
- Favorite icon

## 16.2 Report Viewer

Controls:

- Date range
- Branch
- Warehouse
- Product
- Category
- Supplier
- Customer
- Sales channel
- Currency
- Compare period

Actions:

- Export Excel
- Export CSV
- Export PDF
- Print
- Save view
- Schedule email
- Share internally

## 16.3 Saved Reports

Users can:

- Save filters
- Rename report
- Set default report
- Share with team
- Schedule delivery

---

# 17. Integrations Page

## 17.1 Integrations Marketplace

Cards:

- Salla
- Zid
- Shopify
- WooCommerce
- Meta Ads
- Google Ads
- TikTok Ads
- Payment gateways
- Shipping companies

Each card should show:

- Connected or not connected
- Last sync
- Sync health
- Setup button

## 17.2 Salla Integration Setup

Steps:

1. Connect Salla account
2. Select store
3. Map products
4. Choose inventory sync rules
5. Choose order sync rules
6. Choose fee settings
7. Test connection
8. Activate sync

Settings:

- Import all products
- Import active products only
- Sync stock automatically
- Sync orders automatically
- Restore stock on cancellation
- Import customer data
- Import shipping fees
- Import discounts
- Import taxes
- Import payment fees
- Default warehouse
- Sync frequency

## 17.3 Sync Logs

Columns:

- Date
- Integration
- Action
- Records processed
- Success
- Failed
- Status
- Error details

Actions:

- Retry
- View details
- Download log

---

# 18. AI Assistant Page

## 18.1 Chat Interface

Elements:

- Conversation list
- Message area
- Suggested questions
- Date context
- Data source indicator
- Export answer
- Save insight

Suggested prompts:

- Show my net profit this month.
- Which products need reordering?
- Why did expenses increase?
- Which campaign is losing money?
- Show slow-moving products.
- Compare this month with last month.

## 18.2 AI Response Format

Responses should include:

- Clear answer
- Supporting numbers
- Calculation explanation
- Related chart or table
- Recommended action
- Data period used

## 18.3 AI Safety

The assistant must:

- Ask for confirmation before changing data
- Show what records will change
- Respect permissions
- Keep an audit record
- Never invent missing values

---

# 19. Notifications Page

## 19.1 Notifications List

Categories:

- Inventory
- Finance
- Sales
- Purchases
- Integrations
- Security
- System

Filters:

- Unread
- Priority
- Category
- Date

Actions:

- Mark as read
- Mark all as read
- Open related record
- Dismiss
- Change notification settings

---

# 20. Users and Permissions Page

## 20.1 Users List

Columns:

- Name
- Email
- Role
- Branch
- Warehouse
- Last login
- Status

Actions:

- Invite user
- Edit role
- Suspend
- Reset password
- Remove access

## 20.2 Roles Page

Default roles:

- Owner
- Administrator
- Accountant
- Warehouse manager
- Warehouse employee
- Sales manager
- Sales employee
- Purchasing manager
- E-commerce manager
- Viewer

## 20.3 Permission Editor

Permission groups:

- Products
- Inventory
- Warehouses
- Purchases
- Sales
- Expenses
- Finance
- Reports
- Integrations
- Users
- Settings

Permission levels:

- View
- Create
- Edit
- Delete
- Approve
- Export
- View cost
- View profit

---

# 21. Settings Page

Sections:

## 21.1 Company Settings

- Company profile
- Logo
- Contact details
- Tax details
- Invoice branding

## 21.2 General Settings

- Language
- Currency
- Time zone
- Date format
- Number format
- Theme

## 21.3 Inventory Settings

- Valuation method
- Negative inventory
- Reorder settings
- Batch tracking
- Expiry tracking
- Serial tracking

## 21.4 Sales Settings

- Default warehouse
- Default tax
- Invoice numbering
- Discount permissions
- Return policy

## 21.5 Purchase Settings

- Purchase numbering
- Approval rules
- Default cost allocation
- Receiving rules

## 21.6 Finance Settings

- Financial year
- Chart of accounts
- Payment methods
- Bank accounts
- Tax settings

## 21.7 Notification Settings

- Email alerts
- WhatsApp alerts
- Push notifications
- Alert frequency

## 21.8 Subscription and Billing

- Current plan
- Usage
- Users
- Warehouses
- Renewal date
- Payment method
- Billing history

---

# 22. Table Design Standards

Every major table should support:

- Search
- Filters
- Sort
- Pagination
- Column customization
- Bulk selection
- Bulk actions
- Export
- Saved views
- Sticky header
- Responsive mobile view

Standard row actions:

- View
- Edit
- Duplicate
- Archive
- Delete or cancel
- View history

---

# 23. Form Design Standards

Forms should:

- Group related fields
- Show required fields clearly
- Validate immediately
- Save drafts automatically
- Warn before leaving unsaved changes
- Support keyboard navigation
- Support attachments
- Use searchable dropdowns
- Show calculation previews
- Explain complex fields with tooltips

---

# 24. Status Design System

Use consistent statuses.

## Inventory

- In stock
- Low stock
- Out of stock
- Overstock
- Damaged
- Expired

## Orders

- Draft
- Confirmed
- Processing
- Shipped
- Completed
- Returned
- Canceled

## Payments

- Unpaid
- Partially paid
- Paid
- Overdue
- Refunded

## Approvals

- Draft
- Pending approval
- Approved
- Rejected

## Integrations

- Connected
- Syncing
- Error
- Disconnected

---

# 25. Mobile Experience

Mobile interface should prioritize:

- Dashboard summary
- Barcode scanning
- Receive stock
- Issue stock
- Create sale
- Add expense
- Check product stock
- Notifications
- Approvals

Mobile bottom navigation:

1. Home
2. Inventory
3. Add
4. Sales
5. More

The camera should support barcode and QR code scanning.

---

# 26. Empty States

Examples:

## No Products

Message:
“No products have been added yet.”

Actions:
- Add product
- Import Excel
- Connect store

## No Sales

Message:
“No sales have been recorded for this period.”

Actions:
- Create sale
- Change date filter

## No Expenses

Message:
“No expenses have been added yet.”

Action:
- Add first expense

Empty states should guide the user toward the next action.

---

# 27. Confirmation and Error Messages

Sensitive actions should use clear confirmation messages.

Examples:

- “This stock adjustment will reduce inventory by 20 units.”
- “Canceling this sale will restore the products to inventory.”
- “Deleting is not allowed because this record affects financial reports.”
- “This action requires owner approval.”

Errors should explain:

- What happened
- Why it happened
- How to fix it

---

# 28. Accessibility

The interface should support:

- Keyboard navigation
- Screen readers
- High contrast
- Clear focus states
- Large touch targets
- Readable font sizes
- Color-independent status indicators
- Reduced motion option

---

# 29. Final UX Instruction

Build all pages as connected working modules.

Do not build static placeholder cards.

The user should be able to move naturally from summary to detail.

Examples:

- Clicking net profit opens the profit and loss breakdown.
- Clicking low stock opens the filtered inventory list.
- Clicking supplier balance opens the supplier statement.
- Clicking a campaign opens campaign profitability.
- Clicking inventory value opens the inventory valuation report.
- Clicking a sales order opens its payments, costs, and net profit.

Every page should clearly answer:

- What is happening?
- What needs attention?
- What action can the user take?
- What is the financial or inventory impact?
