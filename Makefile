# 光明顶 v1 —— 交付证据一条命令（issue #26）
# 用法：cd 部署目录 && make verify（部署目录里放本 Makefile 或软链到仓库）
.PHONY: verify

verify:
	bash scripts/verify.sh
