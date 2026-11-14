.PHONY: verify

## make verify —— 一条命令打印 #26 全部交付证据：commit sha + /healthz 原文 + settleDay bench + prod 11 表 count（只读）
verify:
	bash scripts/verify.sh
