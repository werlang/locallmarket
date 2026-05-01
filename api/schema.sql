CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) NOT NULL,
    api_key_ciphertext TEXT NOT NULL,
    api_key_lookup_hash CHAR(64) NOT NULL,
    name VARCHAR(120) NULL,
    email VARCHAR(255) NULL,
    max_price DECIMAL(18, 6) NULL,
    min_tps INT UNSIGNED NULL,
    credits DECIMAL(18, 6) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_users_api_key_lookup_hash (api_key_lookup_hash)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS workers (
    id VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    model VARCHAR(128) NULL,
    tps INT UNSIGNED NULL,
    price DECIMAL(18, 6) NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'disconnected',
    connected_at DATETIME NULL,
    disconnected_at DATETIME NULL,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_workers_user_id (user_id),
    KEY idx_workers_status (status),
    KEY idx_workers_user_status (user_id, status),
    CONSTRAINT fk_workers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    requester_id VARCHAR(128) NOT NULL,
    worker_id VARCHAR(128) NOT NULL,
    model VARCHAR(128) NOT NULL,
    price DECIMAL(18, 6) NOT NULL,
    tps INT UNSIGNED NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'running',
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_orders_requester_id (requester_id),
    KEY idx_orders_worker_id (worker_id),
    KEY idx_orders_model (model),
    KEY idx_orders_status (status),
    CONSTRAINT fk_orders_requester FOREIGN KEY (requester_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_orders_worker FOREIGN KEY (worker_id) REFERENCES workers (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;