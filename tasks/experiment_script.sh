# 示例实验：同一套烹饪任务，逐条跑一遍（每条之间留足时间）。
# 只有一个 OpenAI 兼容供应商，模型名直接写；去哪个端点由 profile 里的 url 决定
# （见 profiles/opencode.json；默认 profile 就是它）。
python3 tasks/evaluation_script.py --model deepseek-v4.1-flash --num_parallel 1 --num_exp 1 --exp_name "2_agent_hells_kitchen" --template_profile ./profiles/tasks/cooking_profile.json --task_path tasks/cooking_tasks/require_collab_test_2_items/2_agent_hells_kitchen_full.json --num_agents 2
sleep 360
python3 tasks/evaluation_script.py --model deepseek-v4.1-flash --num_parallel 1 --num_exp 1 --exp_name "2_agent_full" --template_profile ./profiles/tasks/cooking_profile.json --task_path tasks/cooking_tasks/require_collab_test_2_items/2_agent_full.json --num_agents 2
sleep 360
python3 tasks/evaluation_script.py --model deepseek-v4.1-flash --num_parallel 1 --num_exp 1 --exp_name "2_agent_block_recipe" --template_profile ./profiles/tasks/cooking_profile.json --task_path tasks/cooking_tasks/require_collab_test_2_items/2_agent_block_recipe_full.json --num_agents 2
