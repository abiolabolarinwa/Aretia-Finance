// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IERC20 { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
interface IWETH { function deposit() external payable; function transfer(address,uint256) external returns (bool); }
interface IPair { function getReserves() external view returns (uint112,uint112,uint32); function token0() external view returns (address); function sync() external; }
interface ICurve { function graduate(address) external; function curves(address) external view returns (uint8,address,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256); }
/// PoC only: repairs a dust-poisoned pair to the curve's deposit ratio and graduates in ONE transaction, so it cannot be re-poisoned in between.
contract Rescue {
    function rescue(ICurve curve, address token, IPair pair, IWETH weth, uint256 maxTokens) external payable {
        (, , , , , , , , uint256 lp, , , uint256 coinIn, ) = curve.curves(token);
        (uint112 r0, uint112 r1, ) = pair.getReserves();
        (uint256 rT, uint256 rC) = pair.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rT != 0 || rC != 0) {
            if (rC * lp < rT * coinIn) { uint256 need = (rT * coinIn + lp - 1) / lp - rC; weth.deposit{value: need}(); weth.transfer(address(pair), need); }
            else { uint256 need = (rC * lp + coinIn - 1) / coinIn - rT; require(need <= maxTokens, "too many"); IERC20(token).transferFrom(msg.sender, address(pair), need); }
            pair.sync();
        }
        curve.graduate(token);
        if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
    }
    receive() external payable {}
}
