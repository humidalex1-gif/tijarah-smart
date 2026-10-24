# Smart Inventory & Financial System
## File 03 — Database Structure & Data Relationships

**Suggested project name:** Tijarah Smart  
**Document version:** 1.0  
**Purpose:** Define the database structure, core entities, important fields, financial relationships, inventory logic, and multi-company architecture.

---

# 1. Database Design Goals

The database must be:

- Secure
- Scalable
- Multi-tenant
- Easy to audit
- Ready for integrations
- Accurate for inventory
- Accurate for financial calculations
- Flexible for multiple businesses
- Flexible for multiple warehouses
- Flexible for multiple currencies
- Flexible for multiple sales channels
- Easy to report from

The database must not allow disconnected data.

Examples:

- A sale must be linked to products.
- A sale must reduce stock.
- A purchase receipt must increase stock.
- An expense must affect financial reports.
- A supplier payment must reduce supplier balance.
- A customer payment must reduce customer balance.
- A product cost update must affect future profitability calculations.
- Historical transactions must preserve the original values used at the time.

---

# 2. Multi-Tenant Architecture

The system should be designed as a SaaS platform.

Every company must have isolated data.

## Main Rule

Every business-related table must include:

- `company_id`

Optional scope fields:

- `branch_id`
- `warehouse_id`

This ensures that users can only access data belonging to their company.

## Recommended Tenant Hierarchy

1. Platform
2. Company
3. Branch
4. Warehouse
5. User

---

# 3. Core Database Conventions

## 3.1 Primary Keys

Use UUIDs for major records.

Example:

- `id UUID PRIMARY KEY`

## 3.2 Common Fields

Most tables should include:

- `id`
- `company_id`
- `created_at`
- `updated_at`
- `created_by`
- `updated_by`
- `status`
- `is_active`
- `deleted_at`

## 3.3 Soft Delete

Important records should not be permanently deleted.

Use:

- `deleted_at`
- `is_archived`
- `status`

Financial and inventory records should be reversed or canceled instead of deleted.

## 3.4 Audit Fields

Sensitive records should include:

- `approved_by`
- `approved_at`
- `canceled_by`
- `canceled_at`
- `cancellation_reason`

---

# 4. Platform Tables

## 4.1 companies

Stores each business account.

Fields:

- `id`
- `name`
- `legal_name`
- `slug`
- `logo_url`
- `email`
- `phone`
- `website`
- `country`
- `city`
- `address`
- `tax_number`
- `commercial_registration_number`
- `default_currency_id`
- `default_language`
- `timezone`
- `financial_year_start`
- `subscription_plan_id`
- `subscription_status`
- `created_at`
- `updated_at`

Relationships:

- One company has many users.
- One company has many branches.
- One company has many warehouses.
- One company has many products.
- One company has many financial accounts.

---

## 4.2 branches

Fields:

- `id`
- `company_id`
- `name`
- `code`
- `phone`
- `email`
- `country`
- `city`
- `address`
- `manager_user_id`
- `is_active`
- `created_at`
- `updated_at`

Relationships:

- One branch belongs to one company.
- One branch may have many warehouses.
- One branch may have many users.
- One branch may have many sales and expenses.

---

## 4.3 subscriptions

Fields:

- `id`
- `company_id`
- `plan_id`
- `start_date`
- `renewal_date`
- `status`
- `billing_cycle`
- `amount`
- `currency_id`
- `payment_method`
- `created_at`

---

## 4.4 subscription_plans

Fields:

- `id`
- `name`
- `monthly_price`
- `yearly_price`
- `max_users`
- `max_warehouses`
- `max_branches`
- `max_products`
- `features_json`
- `is_active`

---

# 5. User and Permission Tables

## 5.1 users

Fields:

- `id`
- `company_id`
- `full_name`
- `email`
- `phone`
- `password_hash`
- `preferred_language`
- `timezone`
- `avatar_url`
- `status`
- `last_login_at`
- `two_factor_enabled`
- `created_at`
- `updated_at`

---

## 5.2 roles

Fields:

- `id`
- `company_id`
- `name`
- `description`
- `is_system_role`
- `created_at`

Examples:

- Owner
- Administrator
- Accountant
- Warehouse Manager
- Sales Employee

---

## 5.3 permissions

Fields:

- `id`
- `code`
- `module`
- `action`
- `description`

Examples:

- `products.view`
- `products.create`
- `inventory.adjust`
- `finance.view_profit`
- `sales.approve_discount`

---

## 5.4 role_permissions

Fields:

- `id`
- `role_id`
- `permission_id`

---

## 5.5 user_roles

Fields:

- `id`
- `user_id`
- `role_id`
- `branch_id`
- `warehouse_id`

---

# 6. Currency and Tax Tables

## 6.1 currencies

Fields:

- `id`
- `code`
- `name`
- `symbol`
- `decimal_places`
- `is_active`

Examples:

- USD
- SAR
- MYR
- AED

---

## 6.2 exchange_rates

Fields:

- `id`
- `company_id`
- `from_currency_id`
- `to_currency_id`
- `rate`
- `rate_date`
- `source`
- `created_at`

---

## 6.3 tax_rates

Fields:

- `id`
- `company_id`
- `name`
- `rate_percentage`
- `country`
- `is_default`
- `is_active`

---

# 7. Product Master Data

## 7.1 product_categories

Fields:

- `id`
- `company_id`
- `parent_category_id`
- `name_ar`
- `name_en`
- `code`
- `description`
- `is_active`

Supports nested categories.

---

## 7.2 brands

Fields:

- `id`
- `company_id`
- `name`
- `logo_url`
- `description`
- `is_active`

---

## 7.3 units_of_measure

Fields:

- `id`
- `company_id`
- `name`
- `code`
- `category`
- `conversion_factor`
- `base_unit_id`

Examples:

- Piece
- Box
- Kilogram
- Meter
- Liter

---

## 7.4 products

Fields:

- `id`
- `company_id`
- `category_id`
- `brand_id`
- `default_supplier_id`
- `unit_of_measure_id`
- `name_ar`
- `name_en`
- `slug`
- `description_ar`
- `description_en`
- `product_type`
- `sku`
- `barcode`
- `qr_code`
- `tax_rate_id`
- `purchase_price`
- `selling_price`
- `wholesale_price`
- `minimum_selling_price`
- `currency_id`
- `weight`
- `length`
- `width`
- `height`
- `reorder_level`
- `reorder_quantity`
- `track_inventory`
- `track_batch`
- `track_expiry`
- `track_serial`
- `allow_backorder`
- `status`
- `created_at`
- `updated_at`

---

## 7.5 product_variants

Fields:

- `id`
- `company_id`
- `product_id`
- `variant_name`
- `sku`
- `barcode`
- `purchase_price`
- `selling_price`
- `wholesale_price`
- `minimum_selling_price`
- `weight`
- `status`

---

## 7.6 product_variant_attributes

Fields:

- `id`
- `variant_id`
- `attribute_name`
- `attribute_value`

Examples:

- Color: Dark Gray
- Size: Large

---

## 7.7 product_images

Fields:

- `id`
- `product_id`
- `variant_id`
- `image_url`
- `sort_order`
- `is_primary`

---

## 7.8 product_bundles

Fields:

- `id`
- `company_id`
- `bundle_product_id`
- `component_product_id`
- `component_variant_id`
- `quantity`

---

# 8. Supplier Tables

## 8.1 suppliers

Fields:

- `id`
- `company_id`
- `name`
- `company_name`
- `contact_person`
- `phone`
- `email`
- `country`
- `city`
- `address`
- `tax_number`
- `currency_id`
- `payment_terms_days`
- `credit_limit`
- `rating`
- `status`
- `notes`
- `created_at`
- `updated_at`

---

## 8.2 supplier_products

Fields:

- `id`
- `supplier_id`
- `product_id`
- `variant_id`
- `supplier_sku`
- `supplier_price`
- `minimum_order_quantity`
- `lead_time_days`
- `last_purchase_date`

---

## 8.3 supplier_documents

Fields:

- `id`
- `supplier_id`
- `document_type`
- `file_url`
- `expiry_date`
- `notes`

---

# 9. Warehouse Tables

## 9.1 warehouses

Fields:

- `id`
- `company_id`
- `branch_id`
- `name`
- `code`
- `country`
- `city`
- `address`
- `manager_user_id`
- `status`
- `created_at`

---

## 9.2 warehouse_zones

Fields:

- `id`
- `warehouse_id`
- `name`
- `code`
- `description`

---

## 9.3 warehouse_bins

Fields:

- `id`
- `warehouse_id`
- `zone_id`
- `name`
- `code`
- `description`

---

## 9.4 inventory_balances

Stores the current stock balance.

Fields:

- `id`
- `company_id`
- `warehouse_id`
- `product_id`
- `variant_id`
- `bin_id`
- `available_quantity`
- `reserved_quantity`
- `damaged_quantity`
- `in_transit_quantity`
- `average_cost`
- `inventory_value`
- `last_updated_at`

Unique rule:

- One balance row per company, warehouse, product, variant, and bin.

---

## 9.5 inventory_movements

This is one of the most important tables.

Fields:

- `id`
- `company_id`
- `warehouse_id`
- `destination_warehouse_id`
- `product_id`
- `variant_id`
- `bin_id`
- `movement_type`
- `quantity`
- `unit_cost`
- `total_cost`
- `direction`
- `reference_type`
- `reference_id`
- `reference_number`
- `batch_id`
- `serial_id`
- `movement_date`
- `reason`
- `notes`
- `created_by`
- `approved_by`
- `created_at`

Examples of `movement_type`:

- purchase_receipt
- sale
- customer_return
- supplier_return
- transfer_out
- transfer_in
- adjustment_in
- adjustment_out
- damaged
- expired
- lost
- internal_use
- promotional_use

---

## 9.6 inventory_reservations

Fields:

- `id`
- `company_id`
- `warehouse_id`
- `product_id`
- `variant_id`
- `sales_order_id`
- `quantity`
- `status`
- `expires_at`
- `created_at`

---

## 9.7 inventory_batches

Fields:

- `id`
- `company_id`
- `product_id`
- `variant_id`
- `batch_number`
- `lot_number`
- `manufacture_date`
- `expiry_date`
- `received_date`
- `unit_cost`
- `remaining_quantity`

---

## 9.8 inventory_serial_numbers

Fields:

- `id`
- `company_id`
- `product_id`
- `variant_id`
- `warehouse_id`
- `serial_number`
- `status`
- `purchase_receipt_id`
- `sales_order_id`

---

# 10. Stock Count Tables

## 10.1 stock_counts

Fields:

- `id`
- `company_id`
- `warehouse_id`
- `count_type`
- `status`
- `started_at`
- `completed_at`
- `created_by`
- `approved_by`
- `notes`

---

## 10.2 stock_count_items

Fields:

- `id`
- `stock_count_id`
- `product_id`
- `variant_id`
- `system_quantity`
- `counted_quantity`
- `difference_quantity`
- `average_cost`
- `difference_value`
- `reason`

---

# 11. Warehouse Transfer Tables

## 11.1 warehouse_transfers

Fields:

- `id`
- `company_id`
- `transfer_number`
- `source_warehouse_id`
- `destination_warehouse_id`
- `status`
- `transfer_date`
- `expected_arrival_date`
- `shipped_at`
- `received_at`
- `created_by`
- `approved_by`
- `notes`

---

## 11.2 warehouse_transfer_items

Fields:

- `id`
- `warehouse_transfer_id`
- `product_id`
- `variant_id`
- `requested_quantity`
- `shipped_quantity`
- `received_quantity`
- `damaged_quantity`
- `unit_cost`

---

# 12. Purchase Tables

## 12.1 purchase_orders

Fields:

- `id`
- `company_id`
- `purchase_order_number`
- `supplier_id`
- `warehouse_id`
- `order_date`
- `expected_arrival_date`
- `currency_id`
- `exchange_rate`
- `subtotal`
- `discount_total`
- `tax_total`
- `additional_cost_total`
- `grand_total`
- `payment_status`
- `receiving_status`
- `approval_status`
- `status`
- `notes`
- `created_by`
- `approved_by`
- `created_at`

---

## 12.2 purchase_order_items

Fields:

- `id`
- `purchase_order_id`
- `product_id`
- `variant_id`
- `ordered_quantity`
- `received_quantity`
- `unit_price`
- `discount_amount`
- `tax_amount`
- `line_total`
- `allocated_additional_cost`
- `landed_unit_cost`

---

## 12.3 purchase_additional_costs

Fields:

- `id`
- `purchase_order_id`
- `cost_type`
- `description`
- `amount`
- `currency_id`
- `allocation_method`
- `supplier_id`
- `expense_id`

Examples:

- International shipping
- Customs
- Insurance
- Handling
- Inspection

---

## 12.4 purchase_receipts

Fields:

- `id`
- `company_id`
- `purchase_order_id`
- `receipt_number`
- `warehouse_id`
- `received_date`
- `status`
- `received_by`
- `notes`

---

## 12.5 purchase_receipt_items

Fields:

- `id`
- `purchase_receipt_id`
- `purchase_order_item_id`
- `product_id`
- `variant_id`
- `received_quantity`
- `damaged_quantity`
- `accepted_quantity`
- `batch_number`
- `expiry_date`
- `unit_cost`

---

## 12.6 supplier_returns

Fields:

- `id`
- `company_id`
- `supplier_id`
- `purchase_order_id`
- `return_number`
- `return_date`
- `status`
- `total_amount`
- `reason`
- `created_by`

---

## 12.7 supplier_return_items

Fields:

- `id`
- `supplier_return_id`
- `product_id`
- `variant_id`
- `quantity`
- `unit_cost`
- `reason`

---

# 13. Customer Tables

## 13.1 customers

Fields:

- `id`
- `company_id`
- `customer_type`
- `name`
- `phone`
- `email`
- `country`
- `city`
- `address`
- `tax_number`
- `credit_limit`
- `payment_terms_days`
- `status`
- `notes`
- `created_at`

---

## 13.2 customer_addresses

Fields:

- `id`
- `customer_id`
- `address_type`
- `country`
- `city`
- `district`
- `street`
- `postal_code`
- `latitude`
- `longitude`
- `is_default`

---

# 14. Sales Tables

## 14.1 sales_channels

Fields:

- `id`
- `company_id`
- `name`
- `channel_type`
- `integration_id`
- `status`

Examples:

- Physical Store
- Salla
- Shopify
- WhatsApp
- Wholesale

---

## 14.2 sales_orders

Fields:

- `id`
- `company_id`
- `sales_order_number`
- `customer_id`
- `sales_channel_id`
- `branch_id`
- `warehouse_id`
- `order_date`
- `currency_id`
- `exchange_rate`
- `subtotal`
- `discount_total`
- `tax_total`
- `shipping_charged`
- `grand_total`
- `paid_amount`
- `remaining_amount`
- `payment_status`
- `fulfillment_status`
- `status`
- `external_order_id`
- `external_order_number`
- `created_by`
- `created_at`

---

## 14.3 sales_order_items

Fields:

- `id`
- `sales_order_id`
- `product_id`
- `variant_id`
- `quantity`
- `unit_price`
- `discount_amount`
- `tax_amount`
- `line_total`
- `unit_cost_snapshot`
- `total_cost`
- `gross_profit`
- `allocated_advertising_cost`
- `allocated_logistics_cost`
- `allocated_platform_fee`
- `allocated_payment_fee`
- `net_profit`

Important:

The sale item must store the cost snapshot used at the time of sale.

Do not recalculate old sales using the product's current cost.

---

## 14.4 sales_order_costs

Fields:

- `id`
- `sales_order_id`
- `cost_type`
- `description`
- `amount`
- `allocation_method`
- `expense_id`

Examples:

- Shipping cost
- Platform fee
- Payment gateway fee
- Sales commission
- Advertising cost

---

## 14.5 sales_invoices

Fields:

- `id`
- `company_id`
- `sales_order_id`
- `invoice_number`
- `invoice_date`
- `due_date`
- `subtotal`
- `tax_total`
- `grand_total`
- `paid_amount`
- `remaining_amount`
- `status`
- `pdf_url`

---

## 14.6 customer_returns

Fields:

- `id`
- `company_id`
- `sales_order_id`
- `customer_id`
- `return_number`
- `return_date`
- `refund_amount`
- `status`
- `reason`
- `created_by`

---

## 14.7 customer_return_items

Fields:

- `id`
- `customer_return_id`
- `sales_order_item_id`
- `product_id`
- `variant_id`
- `quantity`
- `condition`
- `return_to_stock`
- `warehouse_id`
- `refund_amount`
- `cost_reversal_amount`

---

# 15. Payment Tables

## 15.1 payment_methods

Fields:

- `id`
- `company_id`
- `name`
- `method_type`
- `financial_account_id`
- `is_active`

Examples:

- Cash
- Bank Transfer
- Card
- Digital Wallet
- Cash on Delivery

---

## 15.2 payments

Fields:

- `id`
- `company_id`
- `payment_number`
- `payment_type`
- `customer_id`
- `supplier_id`
- `sales_order_id`
- `sales_invoice_id`
- `purchase_order_id`
- `financial_account_id`
- `payment_method_id`
- `amount`
- `currency_id`
- `exchange_rate`
- `payment_date`
- `reference_number`
- `status`
- `notes`
- `created_by`

Payment types:

- customer_payment
- supplier_payment
- refund
- owner_contribution
- owner_withdrawal
- account_transfer

---

# 16. Expense Tables

## 16.1 expense_categories

Fields:

- `id`
- `company_id`
- `parent_category_id`
- `name`
- `code`
- `financial_account_id`
- `is_active`

---

## 16.2 expenses

Fields:

- `id`
- `company_id`
- `expense_number`
- `expense_category_id`
- `supplier_id`
- `product_id`
- `campaign_id`
- `warehouse_id`
- `branch_id`
- `financial_account_id`
- `payment_method_id`
- `expense_date`
- `description`
- `amount`
- `currency_id`
- `exchange_rate`
- `tax_amount`
- `total_amount`
- `is_recurring`
- `recurrence_rule`
- `approval_status`
- `status`
- `receipt_url`
- `notes`
- `created_by`
- `approved_by`

---

# 17. Advertising Tables

## 17.1 advertising_platforms

Fields:

- `id`
- `company_id`
- `name`
- `platform_type`
- `integration_id`
- `status`

---

## 17.2 advertising_campaigns

Fields:

- `id`
- `company_id`
- `platform_id`
- `name`
- `external_campaign_id`
- `start_date`
- `end_date`
- `budget`
- `actual_spend`
- `currency_id`
- `status`
- `attribution_method`
- `created_at`

---

## 17.3 campaign_products

Fields:

- `id`
- `campaign_id`
- `product_id`
- `variant_id`
- `allocation_percentage`

---

## 17.4 campaign_daily_metrics

Fields:

- `id`
- `campaign_id`
- `metric_date`
- `spend`
- `impressions`
- `clicks`
- `orders`
- `revenue`
- `attributed_gross_profit`
- `attributed_net_profit`
- `roas`
- `cost_per_order`

---

# 18. Financial Accounting Tables

## 18.1 chart_of_accounts

Fields:

- `id`
- `company_id`
- `parent_account_id`
- `account_code`
- `account_name`
- `account_type`
- `normal_balance`
- `is_system_account`
- `is_active`

Account types:

- Asset
- Liability
- Equity
- Revenue
- Cost of Goods Sold
- Expense

---

## 18.2 financial_accounts

Fields:

- `id`
- `company_id`
- `chart_account_id`
- `name`
- `account_type`
- `currency_id`
- `opening_balance`
- `current_balance`
- `bank_name`
- `account_number_masked`
- `status`

---

## 18.3 journal_entries

Fields:

- `id`
- `company_id`
- `journal_number`
- `entry_date`
- `reference_type`
- `reference_id`
- `description`
- `status`
- `created_by`
- `approved_by`
- `created_at`

---

## 18.4 journal_entry_lines

Fields:

- `id`
- `journal_entry_id`
- `chart_account_id`
- `financial_account_id`
- `debit_amount`
- `credit_amount`
- `currency_id`
- `exchange_rate`
- `description`

Rule:

- Total debit must always equal total credit.

---

## 18.5 account_balances

Fields:

- `id`
- `company_id`
- `chart_account_id`
- `financial_period_id`
- `opening_balance`
- `debit_total`
- `credit_total`
- `closing_balance`

---

## 18.6 financial_periods

Fields:

- `id`
- `company_id`
- `name`
- `start_date`
- `end_date`
- `status`
- `closed_at`
- `closed_by`

---

# 19. Receivable and Payable Tables

## 19.1 customer_ledger

Fields:

- `id`
- `company_id`
- `customer_id`
- `transaction_date`
- `transaction_type`
- `reference_type`
- `reference_id`
- `debit_amount`
- `credit_amount`
- `running_balance`

---

## 19.2 supplier_ledger

Fields:

- `id`
- `company_id`
- `supplier_id`
- `transaction_date`
- `transaction_type`
- `reference_type`
- `reference_id`
- `debit_amount`
- `credit_amount`
- `running_balance`

---

# 20. Integration Tables

## 20.1 integrations

Fields:

- `id`
- `company_id`
- `integration_type`
- `name`
- `status`
- `access_token_encrypted`
- `refresh_token_encrypted`
- `token_expires_at`
- `settings_json`
- `last_sync_at`
- `created_at`

---

## 20.2 integration_mappings

Fields:

- `id`
- `integration_id`
- `entity_type`
- `internal_id`
- `external_id`
- `external_sku`
- `last_synced_at`

Examples:

- Internal product to Salla product
- Internal customer to external customer

---

## 20.3 integration_sync_logs

Fields:

- `id`
- `integration_id`
- `sync_type`
- `started_at`
- `completed_at`
- `records_processed`
- `records_successful`
- `records_failed`
- `status`
- `error_summary`

---

## 20.4 integration_sync_errors

Fields:

- `id`
- `sync_log_id`
- `entity_type`
- `external_id`
- `error_code`
- `error_message`
- `raw_payload_json`
- `resolved_at`

---

# 21. Notification Tables

## 21.1 notifications

Fields:

- `id`
- `company_id`
- `user_id`
- `notification_type`
- `title`
- `message`
- `priority`
- `reference_type`
- `reference_id`
- `is_read`
- `read_at`
- `created_at`

---

## 21.2 notification_preferences

Fields:

- `id`
- `user_id`
- `notification_type`
- `in_app_enabled`
- `email_enabled`
- `whatsapp_enabled`
- `push_enabled`

---

# 22. Audit Tables

## 22.1 audit_logs

Fields:

- `id`
- `company_id`
- `user_id`
- `action`
- `entity_type`
- `entity_id`
- `old_values_json`
- `new_values_json`
- `ip_address`
- `user_agent`
- `created_at`

---

# 23. File and Attachment Tables

## 23.1 attachments

Fields:

- `id`
- `company_id`
- `entity_type`
- `entity_id`
- `file_name`
- `file_url`
- `file_type`
- `file_size`
- `uploaded_by`
- `created_at`

---

# 24. AI Assistant Tables

## 24.1 ai_conversations

Fields:

- `id`
- `company_id`
- `user_id`
- `title`
- `created_at`
- `updated_at`

---

## 24.2 ai_messages

Fields:

- `id`
- `conversation_id`
- `role`
- `message_text`
- `data_context_json`
- `created_at`

---

## 24.3 ai_actions

Fields:

- `id`
- `company_id`
- `conversation_id`
- `user_id`
- `action_type`
- `requested_changes_json`
- `confirmation_status`
- `executed_at`
- `result_json`

---

# 25. Important Data Relationships

## Company Relationships

- Company has many branches.
- Company has many warehouses.
- Company has many users.
- Company has many products.
- Company has many suppliers.
- Company has many customers.
- Company has many sales orders.
- Company has many purchase orders.
- Company has many expenses.
- Company has many financial accounts.

## Product Relationships

- Product belongs to category.
- Product may belong to brand.
- Product may have variants.
- Product may have many suppliers.
- Product may exist in many warehouses.
- Product may appear in many sales and purchase orders.
- Product may be linked to campaigns and expenses.

## Warehouse Relationships

- Warehouse belongs to company and optional branch.
- Warehouse contains inventory balances.
- Warehouse creates inventory movements.
- Warehouse sends and receives transfers.
- Warehouse receives purchase orders.
- Warehouse fulfills sales orders.

## Sales Relationships

- Sales order belongs to customer.
- Sales order belongs to sales channel.
- Sales order uses one warehouse.
- Sales order has many items.
- Sales order has payments.
- Sales order may have invoice.
- Sales order may have returns.
- Sales order has profitability costs.

## Purchase Relationships

- Purchase order belongs to supplier.
- Purchase order is received into warehouse.
- Purchase order has many items.
- Purchase order may have many receipts.
- Purchase order may have additional costs.
- Purchase order may have supplier payments.
- Purchase order may have supplier returns.

---

# 26. Inventory Transaction Logic

## Purchase Receipt

When a purchase receipt is confirmed:

1. Create purchase receipt.
2. Create inventory movement with direction `IN`.
3. Increase available inventory.
4. Update average product cost.
5. Increase inventory asset value.
6. Increase supplier payable if unpaid.
7. Create journal entry.

## Sale Confirmation

When a sale is confirmed:

1. Validate stock availability.
2. Reserve or reduce stock.
3. Create inventory movement with direction `OUT`.
4. Store cost snapshot in sales order item.
5. Create revenue.
6. Create cost of goods sold.
7. Update customer receivable or payment account.
8. Calculate gross profit.
9. Calculate net profit.
10. Create journal entry.

## Customer Return

When a customer return is approved:

1. Create return record.
2. Reverse revenue partly or fully.
3. Reverse customer receivable or issue refund.
4. Return stock if sellable.
5. Move damaged item to damaged stock if not sellable.
6. Reverse cost of goods sold.
7. Recalculate order profitability.
8. Create journal entry.

## Stock Adjustment

When stock is adjusted:

1. Require reason.
2. Require approval for sensitive adjustments.
3. Create inventory movement.
4. Update inventory balance.
5. Calculate financial impact.
6. Create audit log.
7. Create journal entry when value changes.

---

# 27. Average Cost Calculation

Recommended first method:

- Weighted Average Cost

Formula:

**New Average Cost = ((Old Quantity × Old Average Cost) + (Received Quantity × New Landed Cost)) ÷ New Total Quantity**

Historical sales must use the cost snapshot saved at sale time.

Future versions may support:

- FIFO
- Specific Identification

---

# 28. Landed Cost Allocation Logic

Additional purchase costs must be distributed across purchase items.

Allocation methods:

- Quantity
- Weight
- Volume
- Product value
- Equal distribution
- Manual percentage

Each purchase order item stores:

- Original unit price
- Allocated additional cost
- Final landed unit cost

---

# 29. Profit Calculation Data Model

At minimum, store these values per sales order item:

- Revenue
- Product cost
- Gross profit
- Advertising cost
- Logistics cost
- Platform fee
- Payment fee
- Sales commission
- Discount impact
- Return impact
- Net profit

Suggested formulas:

**Gross Profit = Line Revenue - Total Product Cost**

**Net Profit = Gross Profit - Advertising Cost - Logistics Cost - Platform Fee - Payment Fee - Sales Commission - Other Allocated Costs**

---

# 30. Data Integrity Rules

The system must enforce:

- No cross-company data access.
- No duplicate SKU within the same company unless explicitly allowed.
- No duplicate external order ID per integration.
- No inventory movement without product and warehouse.
- No financial journal where debit does not equal credit.
- No negative payment amount.
- No invoice total different from its line totals.
- No stock adjustment without reason.
- No deletion of posted financial records.
- No sale confirmation without inventory validation unless backorders are enabled.
- No transfer receiving above shipped quantity without approval.

---

# 31. Recommended Indexes

Create indexes for:

- `company_id`
- `company_id + created_at`
- `company_id + status`
- `company_id + sku`
- `company_id + barcode`
- `warehouse_id + product_id + variant_id`
- `sales_order_number`
- `purchase_order_number`
- `external_order_id`
- `customer_id + transaction_date`
- `supplier_id + transaction_date`
- `movement_date`
- `campaign_id + metric_date`

---

# 32. Reporting Views

Create database views or materialized views for:

- Current inventory summary
- Inventory valuation
- Product profitability
- Sales profitability
- Customer balances
- Supplier balances
- Monthly profit and loss
- Daily cash flow
- Campaign profitability
- Low-stock products
- Slow-moving products
- Warehouse comparison

---

# 33. Backup and Recovery

Requirements:

- Automatic daily backups
- Point-in-time recovery
- Encrypted backups
- Backup retention policy
- Restore testing
- Separate production and test databases
- No direct production edits without logging

---

# 34. Recommended Technology Direction

Possible cloud stack:

- PostgreSQL database
- Supabase or managed PostgreSQL
- Object storage for files
- Row-level security
- Background jobs for synchronization
- API layer for integrations
- Queue system for large imports
- Scheduled jobs for reports and alerts

The database design must remain independent enough to move between cloud providers if needed.

---

# 35. Final Database Instruction

Build the database so that inventory, finance, purchases, sales, expenses, and advertising are connected.

Do not store only totals.

Store the detailed transactions that created each total.

Every dashboard number must be traceable back to source records.

Examples:

- Net profit must link back to sales, product costs, expenses, and fees.
- Inventory value must link back to warehouse balances and product costs.
- Supplier balance must link back to purchase orders and payments.
- Customer balance must link back to invoices and payments.
- Advertising profitability must link back to campaigns and attributed sales.

The database must prioritize:

1. Accuracy
2. Auditability
3. Security
4. Performance
5. Scalability
